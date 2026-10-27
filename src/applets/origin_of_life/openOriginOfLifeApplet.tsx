import { OpenAppletOptions, OpenedApplet } from "../../core/host";
import { OriginOfLifeCanvas } from "./OriginOfLifeCanvas";

export function openOriginOfLifeApplet(options?: OpenAppletOptions): OpenedApplet {
  return {
    id: "origin-of-life",
    title: "Where could life begin?",
    description:
      "From no life to life on the early Earth: building blocks concentrate, join into chains, copy themselves and become enclosed in a shallow pool, the open ocean or a hydrothermal vent, depending on ingredients, energy and stability.",
    close: () => {
      options?.host?.onClose?.();
    },
    render: () => <OriginOfLifeCanvas host={options?.host} />
  };
}
