"""Build onnx/model_q4.onnx for onnxruntime-web WASM from LiquidAI's model_q4.onnx:
 1. the num_logits_to_keep edit (identical to the Web q4f16 build), and
 2. the com.microsoft GatherBlockQuantized embedding lookup replaced by standard ONNX ops
    (Gather, Cast, Div, Floor, Mul, Sub, Unsqueeze, Concat, Reshape) that read the SAME packed
    4-bit initializers, because some onnxruntime-web 1.31.1 WASM builds (asyncify, used by
    ort.webgpu.bundle.min.mjs, and jspi) have no CPU kernel for GatherBlockQuantized.
Graph-only: the external data file is never read or written; initializer references unchanged."""
import sys, onnx
import numpy as np
from onnx import helper, numpy_helper, TensorProto
from add_num_logits_to_keep import edit as add_num_logits_to_keep

def replace_gbq(m):
    g = m.graph
    idx = [i for i, n in enumerate(g.node) if n.op_type == 'GatherBlockQuantized']
    assert len(idx) == 1, idx
    i = idx[0]; n = g.node[i]
    attrs = {a.name: helper.get_attribute_value(a) for a in n.attribute}
    assert n.domain == 'com.microsoft' and attrs == {'bits': 4, 'block_size': 32, 'gather_axis': 0, 'quantize_axis': 1}, attrs
    data, ids, scales, zp = n.input
    out = n.output[0]
    init = {t.name: t for t in g.initializer}
    D, S, Z = init[data], init[scales], init[zp]
    assert D.data_type == TensorProto.UINT8 and list(D.dims) == [65536, 1024]
    assert S.data_type == TensorProto.FLOAT and list(S.dims) == [65536, 64]
    assert Z.data_type == TensorProto.UINT8 and list(Z.dims) == [65536, 32]
    # the packed embedding table must not be used by anything else
    assert [x.name for x in g.node if data in x.input] == [n.name]
    P = '/model/embed_tokens/Dequant'
    def c(name, arr):
        g.initializer.append(numpy_helper.from_array(arr, f'{P}/{name}'))
        return f'{P}/{name}'
    sixteen = c('sixteen', np.array(16.0, np.float32))
    ax_last = c('axes_last', np.array([-1], np.int64))
    shp_w = c('shape_blocks', np.array([0, 0, 64, 32], np.int64))   # [B,S,1024,2] -> [B,S,64,32]
    shp_z = c('shape_zp', np.array([0, 0, 64, 1], np.int64))        # [B,S,32,2]   -> [B,S,64,1]
    shp_o = c('shape_out', np.array([0, 0, 2048], np.int64))        # [B,S,64,32]  -> [B,S,2048]
    nodes = []
    def node(op, ins, name, **kw):
        o = f'{P}/{name}/output_0'
        nodes.append(helper.make_node(op, ins, [o], name=f'{P}/{name}', **kw)); return o
    def unpack(packed_u8, tag):
        # uint8 byte b holds two 4-bit values: low nibble = even element, high nibble = odd element
        f = node('Cast', [packed_u8], f'{tag}/Cast', to=TensorProto.FLOAT)
        hi = node('Floor', [node('Div', [f, sixteen], f'{tag}/Div')], f'{tag}/Floor')
        lo = node('Sub', [f, node('Mul', [hi, sixteen], f'{tag}/Mul')], f'{tag}/Sub')
        lo_u = node('Unsqueeze', [lo, ax_last], f'{tag}/UnsqueezeLo')
        hi_u = node('Unsqueeze', [hi, ax_last], f'{tag}/UnsqueezeHi')
        return node('Concat', [lo_u, hi_u], f'{tag}/Concat', axis=-1)   # [..., n, 2] = lo0,hi0,lo1,hi1...
    q = node('Gather', [data, ids], 'GatherData', axis=0)                # [B,S,1024] uint8
    w = node('Reshape', [unpack(q, 'Data'), shp_w], 'Data/Reshape')       # [B,S,64,32]
    zq = node('Gather', [zp, ids], 'GatherZp', axis=0)                   # [B,S,32] uint8
    z = node('Reshape', [unpack(zq, 'Zp'), shp_z], 'Zp/Reshape')          # [B,S,64,1]
    s = node('Gather', [scales, ids], 'GatherScales', axis=0)            # [B,S,64] float32
    s = node('Unsqueeze', [s, ax_last], 'Scales/Unsqueeze')              # [B,S,64,1]
    y = node('Mul', [node('Sub', [w, z], 'SubZp'), s], 'MulScale')       # [B,S,64,32]
    nodes.append(helper.make_node('Reshape', [y, shp_o], [out], name=f'{P}/Reshape'))
    del g.node[i]
    for k, nn in enumerate(nodes):
        g.node.insert(i + k, nn)
    # drop com.microsoft opset? no: MatMulNBits, GroupQueryAttention etc. still use it
    return m

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    m = onnx.load(src, load_external_data=False)
    add_num_logits_to_keep(m)
    replace_gbq(m)
    data = m.SerializeToString()
    open(dst, 'wb').write(data)
    print('wrote', dst, len(data))
