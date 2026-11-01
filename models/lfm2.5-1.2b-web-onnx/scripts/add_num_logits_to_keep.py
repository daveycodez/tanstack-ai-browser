"""Add a num_logits_to_keep int64 scalar input to an LFM2.5 ONNX graph and slice the
final-norm hidden states to the last N positions before the LM head (0 keeps all).
Graph-only edit: external data references (location/offset/length) are left untouched,
and the external data file is never read or written."""
import sys, onnx
from onnx import helper, TensorProto, numpy_helper
import numpy as np

HIDDEN = '/model/layers.16/final_norm_layernorm/output_0'
LM_HEAD = '/lm_head/MatMul_Quant'
P = '/lm_head/num_logits_to_keep'

def edit(m):
    g = m.graph
    assert not any(i.name == 'num_logits_to_keep' for i in g.input)
    idx = [i for i, n in enumerate(g.node) if n.name == LM_HEAD]
    assert len(idx) == 1
    lm = g.node[idx[0]]
    assert lm.op_type == 'MatMulNBits' and lm.input[0] == HIDDEN
    # HIDDEN must only feed the LM head (otherwise slicing is still fine, but check assumptions)
    consumers = [n.name for n in g.node if HIDDEN in n.input]
    assert consumers == [LM_HEAD], consumers
    lm_out = lm.output[0]
    # constants (appended after existing initializers, raw int64 like the Web build)
    for name, val in ((f'{P}/axes', 0), (f'{P}/ends', 2147483647), (f'{P}/slice_axes', 1)):
        t = numpy_helper.from_array(np.array([val], dtype=np.int64), name)
        g.initializer.append(t)
    new_nodes = [
        helper.make_node('Neg', ['num_logits_to_keep'], [f'{P}/Neg/output_0'], name=f'{P}/Neg'),
        helper.make_node('Unsqueeze', [f'{P}/Neg/output_0', f'{P}/axes'], [f'{P}/Unsqueeze/output_0'], name=f'{P}/Unsqueeze'),
        helper.make_node('Slice', [HIDDEN, f'{P}/Unsqueeze/output_0', f'{P}/ends', f'{P}/slice_axes'], [f'{P}/Slice/output_0'], name=f'{P}/Slice'),
    ]
    # move the LM head to the end, after the three new nodes (same layout as the Web q4f16 build)
    lm_copy = onnx.NodeProto(); lm_copy.CopyFrom(lm)
    lm_copy.input[0] = f'{P}/Slice/output_0'
    del g.node[idx[0]]
    g.node.extend(new_nodes + [lm_copy])
    # drop stale value_info for the LM head output (its sequence dim changes)
    for i in reversed(range(len(g.value_info))):
        if g.value_info[i].name == lm_out:
            del g.value_info[i]
    # new input, last
    g.input.append(helper.make_tensor_value_info('num_logits_to_keep', TensorProto.INT64, []))
    # logits output: [batch_size, logits_sequence_length, 65536]
    out = [o for o in g.output if o.name == 'logits']; assert len(out) == 1
    d = out[0].type.tensor_type.shape.dim
    assert d[1].dim_param == 'sequence_length' and d[2].dim_value == 65536
    d[1].ClearField('dim_value'); d[1].dim_param = 'logits_sequence_length'
    return m

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    m = onnx.load(src, load_external_data=False)
    edit(m)
    data = m.SerializeToString()
    with open(dst, 'wb') as f:
        f.write(data)
    print('wrote', dst, len(data))
