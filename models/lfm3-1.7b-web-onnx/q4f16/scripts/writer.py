import os, numpy as np, onnx
from onnx import TensorProto
def write_model(m, src, new_arrays, outdir, data_name='model_q4f16.onnx_data', order=None):
    """Rewrite all initializers of graph m into outdir/<data_name> (new_arrays override src).
    Tensors < 1 KB stay inline. order: optional list of initializer names giving file order."""
    os.makedirs(outdir, exist_ok=True); g = m.graph
    existing = {t.name for t in g.initializer}
    for nm, arr in new_arrays.items():
        if nm not in existing: g.initializer.append(onnx.numpy_helper.from_array(arr, nm))
    inits = list(g.initializer)
    if order:
        pos = {n: i for i, n in enumerate(order)}; inits.sort(key=lambda t: pos.get(t.name, len(pos)))
    off = 0
    with open(os.path.join(outdir, data_name), 'wb') as fo:
        for t in inits:
            arr = new_arrays.get(t.name)
            if arr is None: arr = src.get(t.name)
            arr = np.ascontiguousarray(arr).reshape(np.shape(arr))
            dt = onnx.helper.np_dtype_to_tensor_dtype(arr.dtype); b = arr.tobytes()
            for f in ('raw_data', 'float_data', 'int64_data', 'int32_data'): t.ClearField(f)
            del t.dims[:]; t.dims.extend(arr.shape); t.data_type = dt
            if len(b) < 1024:
                t.data_location = TensorProto.DEFAULT; del t.external_data[:]; t.raw_data = b; continue
            pad = (-off) % 64; fo.write(b'\0' * pad); off += pad; fo.write(b)
            t.data_location = TensorProto.EXTERNAL; del t.external_data[:]
            for k, v in (('location', data_name), ('offset', str(off)), ('length', str(len(b)))):
                e = t.external_data.add(); e.key = k; e.value = v
            off += len(b)
    onnx.save(m, os.path.join(outdir, 'model_q4f16.onnx'))
    return off
