"""A GPTQ-style Q4_0 head: quantize the tied embedding / LM head to Q4_0 (llama.cpp's block format, so the WebGL engine reads
it natively) while compensating each column's rounding error in the columns not yet quantized, using the full covariance of
the final (normed) hidden states, not only its diagonal as llama.cpp's importance matrix does.
usage:
  gptq_head.py cov <port> <tokenizer.json> <cal text> <out.npz>
      hidden states from a running `llama-server --embeddings --pooling none` (QAD model), in 512-token chunks: E[h hᵀ]
  gptq_head.py quant <gguf-py dir> <qad.gguf> <cov.npz> <out donor.gguf> [damp, default 0.01] [source.gguf]
      writes a GGUF holding only token_embd.weight (Q4_0); splice it with `ggufhead.py splice`. Source values: the QAD
      file's dequantized head, or another GGUF's token_embd (e.g. Liquid's BF16).
"""
import sys, json, urllib.request, numpy as np

cmd = sys.argv[1]
if cmd == "cov":
    from tokenizers import Tokenizer
    port, tokp, calp, out = sys.argv[2:6]
    ids = Tokenizer.from_file(tokp).encode(open(calp, encoding="utf-8").read(), add_special_tokens=False).ids
    C = np.zeros((2048, 2048)); n = 0
    for i in range(0, len(ids), 512):
        body = json.dumps({"content": ids[i:i + 512]}).encode()
        r = urllib.request.Request(f"http://127.0.0.1:{port}/embedding", data=body, headers={"Content-Type": "application/json"})
        h = np.asarray(json.load(urllib.request.urlopen(r, timeout=600))[0]["embedding"], dtype=np.float64)
        C += h.T @ h; n += h.shape[0]
    np.savez(out, C=C / n, n=n)
    print(f"{n} tokens; diag mean {np.diag(C / n).mean():.4f}")
elif cmd == "quant":
    sys.path.insert(0, sys.argv[2])
    import gguf
    from gguf.quants import dequantize
    qad, covp, out = sys.argv[3:6]
    damp = float(sys.argv[6]) if len(sys.argv) > 6 else 0.01
    src = sys.argv[7] if len(sys.argv) > 7 else qad
    t = next(x for x in gguf.GGUFReader(src).tensors if x.name == "token_embd.weight")
    W = (np.asarray(t.data, dtype=np.float32) if t.tensor_type == gguf.GGMLQuantizationType.F32 else
         dequantize(np.asarray(t.data), t.tensor_type)).reshape(-1, 2048).astype(np.float32)
    rows, K = W.shape
    H = np.load(covp)["C"].astype(np.float64)
    H += damp * np.mean(np.diag(H)) * np.eye(K)
    Hinv = np.linalg.cholesky(np.linalg.inv(H)).T  # upper Cholesky factor of H^-1, as in GPTQ
    Hinv = Hinv.astype(np.float32)
    B = 128
    d_all = np.zeros((rows, K // 32), dtype=np.float16)
    q_all = np.zeros((rows, K), dtype=np.uint8)
    for r0 in range(0, rows, 16384):
        Wc = W[r0:r0 + 16384].copy()
        for i1 in range(0, K, B):
            i2 = i1 + B
            W1 = Wc[:, i1:i2].copy(); E1 = np.zeros_like(W1); H1 = Hinv[i1:i2, i1:i2]
            for i in range(B):
                c = i1 + i
                if c % 32 == 0:  # the block's scale from its current (error-compensated) values, ggml's Q4_0 rule
                    blk = W1[:, i:i + 32]
                    idx = np.abs(blk).argmax(1)
                    vmax = blk[np.arange(blk.shape[0]), idx]
                    d = (vmax / -8.0).astype(np.float16)
                    d_all[r0:r0 + len(Wc), c // 32] = d
                    df = d.astype(np.float32); inv = np.where(df != 0, 1.0 / np.where(df != 0, df, 1), 0)
                w = W1[:, i]
                q = np.clip(np.floor(w * inv + 8.5), 0, 15)
                wq = (q - 8) * df
                q_all[r0:r0 + len(Wc), c] = q.astype(np.uint8)
                err = (w - wq) / H1[i, i]
                W1[:, i:] -= np.outer(err, H1[i, i:])
                E1[:, i] = err
            Wc[:, i2:] -= E1 @ Hinv[i1:i2, i2:]
        print(f"rows {r0}..{r0 + len(Wc)}", flush=True)
    # ggml block_q4_0: fp16 d, then 16 bytes: qs[j] = q[j] | q[j + 16] << 4
    qb = q_all.reshape(rows, K // 32, 32)
    packed = (qb[:, :, :16] | (qb[:, :, 16:] << 4)).astype(np.uint8)
    blocks = np.concatenate([d_all.reshape(rows, K // 32, 1).view(np.uint8), packed], axis=2).reshape(rows, -1)
    deq = dequantize(blocks, gguf.GGMLQuantizationType.Q4_0).reshape(rows, K)
    C = np.load(covp)["C"].astype(np.float32)
    E = deq - W
    print(f"relative error vs source {np.linalg.norm(E) / np.linalg.norm(W):.5f}; output-weighted tr(E C Et)/tr(W C Wt) "
          f"{np.sum((E @ C) * E) / np.sum((W @ C) * W):.6f}")
    w = gguf.GGUFWriter(out, arch="lfm3")
    w.add_tensor("token_embd.weight", blocks, raw_dtype=gguf.GGMLQuantizationType.Q4_0)
    w.write_header_to_file(); w.write_kv_data_to_file(); w.write_tensors_to_file(); w.close()
else:
    sys.exit(__doc__)
