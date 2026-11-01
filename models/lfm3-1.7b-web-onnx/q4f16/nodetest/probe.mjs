import ort from 'onnxruntime-node';
console.log(ort.env.versions, typeof ort.listSupportedBackends === 'function' ? ort.listSupportedBackends() : '');
