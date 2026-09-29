export type Arm = "on" | "off";
export type PairOrder = [Arm, Arm];

export function balancedPairOrders(seed: number): PairOrder[][] {
  if (!Number.isSafeInteger(seed) || seed <= 0 || seed > 0xffffffff)
    throw new Error("Row ablation seed must be a positive 32-bit integer");
  let state = seed;
  function random() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  }
  return Array.from({ length: 3 }, () => {
    const orders = Array.from({ length: 10 }, (_, index): PairOrder =>
      index < 5 ? ["on", "off"] : ["off", "on"],
    );
    for (let index = orders.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [orders[index], orders[other]] = [orders[other], orders[index]];
    }
    return orders;
  });
}
