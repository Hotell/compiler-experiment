type WidgetState = { root: { style: Record<string, string | undefined> } };

const styleKeys = { color: "--widget-color", fill: "--widget-fill" };

export const useWidgetStyle = (
  state: WidgetState,
  iconName: string | undefined,
  iconColor: string | undefined,
) => {
  state.root.style = {
    [styleKeys.color]: iconColor,
    [styleKeys.fill]: iconColor,
  };
  return state.root.style;
};
