export const Example = ({ label }: { label: string }) => {
  function renderContent() {
    return <span>{label}</span>;
  }

  return <div>{renderContent()}</div>;
};
