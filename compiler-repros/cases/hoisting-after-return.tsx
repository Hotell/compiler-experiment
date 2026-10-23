export const Example = ({ label }: { label: string }) => {
  return <div>{renderContent()}</div>;

  function renderContent() {
    return <span>{label}</span>;
  }
};
