import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const { outputText, diagnostics } = ts.transpileModule(
  readFileSync(new URL("./row-ablation-order.ts", import.meta.url), "utf8"),
  {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  },
);
assert.deepEqual(diagnostics, []);
const { balancedPairOrders } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

test("three independently shuffled blocks each contain five pairs in each order", () => {
  for (const seed of [1, 20260929, 0xffffffff]) {
    const blocks = balancedPairOrders(seed);
    assert.equal(blocks.length, 3);
    for (const block of blocks) {
      assert.equal(block.length, 10);
      assert.equal(block.filter(([first]) => first === "on").length, 5);
      assert.equal(block.filter(([first]) => first === "off").length, 5);
      for (const order of block) assert.deepEqual([...order].sort(), ["off", "on"]);
    }
  }
});

test("recorded seed reproduces the entire order schedule without shared mutable tuples", () => {
  const orders = balancedPairOrders(20260929);
  assert.deepEqual(orders, balancedPairOrders(20260929));
  assert.notDeepEqual(orders, balancedPairOrders(20260930));
  assert.equal(new Set(orders.flat()).size, 30);
  assert.deepEqual(
    orders.map((block) => block.map(([first]) => first).join(",")),
    [
      "off,on,off,off,on,on,on,off,off,on",
      "off,on,off,on,off,off,on,off,on,on",
      "on,off,off,on,off,on,on,off,off,on",
    ],
  );
});

test("invalid or truncated seeds fail instead of silently choosing an order", () => {
  for (const seed of [0, -1, 1.5, NaN, Infinity, 0x100000000, "20260929", undefined])
    assert.throws(() => balancedPairOrders(seed), /positive 32-bit integer/);
});
