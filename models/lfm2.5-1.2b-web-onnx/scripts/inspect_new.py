import sys, onnx
b=onnx.load(sys.argv[1], load_external_data=False)
print('input index of num_logits_to_keep:', [i for i,x in enumerate(b.graph.input) if x.name=='num_logits_to_keep'], 'of', len(b.graph.input))
print([x for x in b.graph.input if x.name=='num_logits_to_keep'][0])
print([x for x in b.graph.output if x.name=='logits'][0])
names=['/lm_head/num_logits_to_keep/axes','/lm_head/num_logits_to_keep/ends','/lm_head/num_logits_to_keep/slice_axes']
for i,t in enumerate(b.graph.initializer):
    if t.name in names: print(i, t)
for i,n in enumerate(b.graph.node):
    if 'logits' in ' '.join(list(n.input)+list(n.output)) or i>=383: print(i, n)
