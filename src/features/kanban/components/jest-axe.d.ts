declare module "jest-axe" {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  import axeCore = require("axe-core");

  export function axe(
    html: axeCore.ElementContext,
    options?: axeCore.RunOptions,
  ): Promise<axeCore.AxeResults>;
}
