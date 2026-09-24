type Props = { items: string[] };

export function InvalidImmutability(props: Props) {
  props.items = [];
  return <div>{props.items.length}</div>;
}
