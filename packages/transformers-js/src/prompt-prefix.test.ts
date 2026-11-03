import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { reusablePrefixLength, systemPrefixTokens } from "./prompt-prefix.js"

describe("reusablePrefixLength", () => {
  test("keeps an exact instruction prefix despite a long template-only closing suffix", () => {
    const instructions = Array.from({ length: 40 }, (_, index) => index + 10)
    const renderedSystem = [...instructions, 700, 701, 702, 703, 704, 705, 706]
    const request = [...instructions, 800, 801, 900, 901]
    assert.equal(reusablePrefixLength(renderedSystem, request), instructions.length)
    // The previous prefix.length - 3 heuristic returned zero for this template.
    assert.ok(instructions.length < renderedSystem.length - 3)
  })

  test("changing schema guidance and current input preserves only the stable leading instructions", () => {
    const stable = [1, 2, 3, 4, 5, 6]
    const first = [...stable, 10, 11, 100, 101]
    const second = [...stable, 20, 21, 200, 201]
    assert.equal(reusablePrefixLength(first, second), stable.length)
    assert.equal(reusablePrefixLength(first, [...stable, 10, 11, 999, 101]), 8)
  })

  test("leaves the final prompt token unread for logits, including an identical retry", () => {
    assert.equal(reusablePrefixLength([1, 2, 3], [1, 2, 3]), 2)
    assert.equal(reusablePrefixLength([1, 2, 3, 4, 5], [1, 2, 3]), 2)
    assert.equal(reusablePrefixLength([1, 2], [1, 2, 3, 4]), 2)
    assert.equal(reusablePrefixLength([1], [1]), 0)
  })

  test("never reuses a nonmatching token or assumes text joins have stable tokenization", () => {
    assert.equal(reusablePrefixLength([1, 2, 3, 4], [1, 2, 9, 8, 7]), 2)
    assert.equal(reusablePrefixLength([5, 6, 7], [1, 6, 7]), 0)
    assert.equal(reusablePrefixLength([], [1, 2]), 0)
    assert.equal(reusablePrefixLength([1, 2], []), 0)
  })

  test("supports typed token arrays without changing either sequence", () => {
    const saved = new Uint32Array([12, 14, 16, 18])
    const prompt = new Uint32Array([12, 14, 99, 101])
    assert.equal(reusablePrefixLength(saved, prompt), 2)
    assert.deepEqual(saved, new Uint32Array([12, 14, 16, 18]))
    assert.deepEqual(prompt, new Uint32Array([12, 14, 99, 101]))
  })
})

describe("system prefixes for templates requiring a user", () => {
  const leading=[{role:"system",content:"Reusable system instructions"}]

  test("supported system-only rendering is unchanged and does not probe user messages", () => {
    let calls=0
    const tokens=systemPrefixTokens(leading,messages=>{calls++;assert.deepEqual(messages,leading);return new Uint32Array([1,2,3,4])})
    assert.deepEqual(tokens,[1,2,3,4])
    assert.equal(calls,1)
  })

  test("user-required templates cache only the common A/B token prefix, never synthetic user content", () => {
    const observed:Array<Array<{role:string;content:string}>>=[]
    const before=JSON.stringify(leading)
    const tokens=systemPrefixTokens(leading,messages=>{
      observed.push(structuredClone(messages))
      if(messages.length===1)throw Error("No user query found in messages.")
      const query=messages.at(-1)?.content
      assert.ok(query==="A"||query==="B")
      return [10,11,12,13,query==="A"?100:200,99]
    })
    assert.deepEqual(tokens,[10,11,12,13])
    assert.equal(reusablePrefixLength(tokens,[10,11,12,13,300,99]),4)
    assert.deepEqual(observed.map(messages=>messages.at(-1)?.content),["Reusable system instructions","A","B"])
    assert.equal(JSON.stringify(leading),before)
  })

  test("a conditional prefix shared by A/B is intersected again with the actual caller prompt", () => {
    const tokens=systemPrefixTokens(leading,messages=>{
      if(messages.length===1)throw Error("user required")
      return [1,2,3,4,messages.at(-1)?.content==="A"?100:200]
    })
    assert.equal(reusablePrefixLength(tokens,[1,2,90,91,92]),2,"actual tokens, not synthetic rendering, decide usable state")
  })

  test("tool-only leading context can use the same user-required fallback", () => {
    const tokens=systemPrefixTokens([],messages=>{
      if(messages.length===0)throw Error("No user query found")
      assert.equal(messages.length,1)
      assert.equal(messages[0].role,"user")
      return [40,41,42,messages[0].content==="A"?100:200]
    })
    assert.deepEqual(tokens,[40,41,42])
  })

  test("unsupported probes safely disable this prefix optimization", () => {
    assert.deepEqual(systemPrefixTokens(leading,()=>{throw Error("template unavailable")}),[])
    assert.deepEqual(systemPrefixTokens(leading,messages=>{
      if(messages.length===1)throw Error("user required")
      return messages.at(-1)?.content==="A"?[1,2,3]:[9,8,7]
    }),[])
  })
})
