import { useState } from "react";

const CounterButton = () => {
  const [index, setIndex] = useState(0);
  return <button onClick={() => setIndex(index + 1)}>{index}</button>;
};

export function Example({ label }: { label: string }) {
  return (
    <div>
      <CounterButton />
      {label}
    </div>
  );
}
