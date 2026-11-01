# Models

How we build the ONNX models we publish on Hugging Face under `daveycodez/`. Each folder is named after its repo, in lowercase, and holds:

- `README.md`: the model card as published. It says what changed from the original and lists the measurements.
- `BUILD.md`: the commands that rebuild the files, in order, with the source revisions.
- the scripts used, including the evaluation and test scripts behind the card's numbers.

| Folder | Hugging Face repo | Built from |
|---|---|---|
| [`lfm3-1.7b-web-onnx`](lfm3-1.7b-web-onnx) | [daveycodez/LFM3-1.7B-Web-ONNX](https://huggingface.co/daveycodez/LFM3-1.7B-Web-ONNX) | onnx-community/LFM3-1.7B-ONNX |
| [`lfm3-1.7b-web-gguf`](lfm3-1.7b-web-gguf) | [daveycodez/LFM3-1.7B-Web-GGUF](https://huggingface.co/daveycodez/LFM3-1.7B-Web-GGUF) | LiquidAI/LFM3-1.7B-GGUF (BF16) |
| [`lfm2.5-1.2b-web-onnx`](lfm2.5-1.2b-web-onnx) | [daveycodez/LFM2.5-1.2B-Web-ONNX](https://huggingface.co/daveycodez/LFM2.5-1.2B-Web-ONNX) | LiquidAI/LFM2.5-1.2B-Instruct-ONNX |
| [`lfm2.5-1.2b-thinking-web-onnx`](lfm2.5-1.2b-thinking-web-onnx) | [daveycodez/LFM2.5-1.2B-Thinking-Web-ONNX](https://huggingface.co/daveycodez/LFM2.5-1.2B-Thinking-Web-ONNX) | LiquidAI/LFM2.5-1.2B-Thinking-ONNX |

## Setup

The GGUF build also needs a native llama.cpp build (see its `BUILD.md`). For the ONNX builds: Python 3.14 with the packages in [`requirements.txt`](requirements.txt), in a `venv` inside the folder you're building:

```bash
cd models/lfm3-1.7b-web-onnx/q4f16
python3 -m venv venv && venv/bin/pip install -r ../../requirements.txt
```

The shell scripts expect `venv/`, downloads in `dl/` and outputs in `out/`, all next to their `scripts/` folder. These folders are ignored by Git. Weights never go in the repo.

The `node*/` and `tjs/` folders are Node test harnesses (onnxruntime-node, onnxruntime-web, Transformers.js) used to check a build on WebGPU and WebAssembly. Run `npm install` inside one before using it. They're not part of the pnpm workspace.

## Notes

- Scripts are kept as they were run, experiments included. Each `BUILD.md` says which ones produced the published files.
- Run Python with `-I`, as the commands do, so nothing in the working directory shadows a package.
- Publishing is a separate step (`hf upload`). Update the folder's `README.md` to match the card whenever you upload.
