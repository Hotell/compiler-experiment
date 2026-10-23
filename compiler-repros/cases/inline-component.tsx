import { useState } from "react";

export function Example({ label }: { label: string }) {
  const CounterButton = () => {
    const [index, setIndex] = useState(0);
    return <button onClick={() => setIndex(index + 1)}>{index}</button>;
  };

  return (
    <div>
      <CounterButton />
      {label}
    </div>
  );
}
