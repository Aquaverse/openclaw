// Fixed responsive inspection coverage; validate before starting servers or browsers.
export const WIDTHS = Object.freeze([1440, 768, 390]);
export function parseInspectOptions(args) {
  const result = {
    out: ".design-taste/inspect",
    allow: [],
    json: false,
    help: false,
    target: null,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--out" || arg === "--allow") {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error(arg + " requires a value");
      if (arg === "--out") result.out = value;
      else {
        const ids = value.split(",").map((x) => x.trim());
        if (ids.some((x) => !/^[a-z][a-z0-9-]*$/.test(x)))
          throw new Error("Invalid allowance rule ID");
        result.allow.push(...ids);
      }
      continue;
    }
    if (arg.startsWith("-")) throw new Error("Unknown option: " + arg);
    if (result.target) throw new Error("Provide exactly one URL or HTML file");
    result.target = arg;
  }
  if (!result.target && !result.help) throw new Error("A URL or HTML file is required");
  return result;
}
