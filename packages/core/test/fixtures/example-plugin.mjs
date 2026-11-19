// Minimal connector plugin. Load it with:
//   kube-triage investigate -n shop --plugin ./example-plugin.mjs
export const plugin = {
  name: "example",
  description: "Reports a fixed piece of evidence, to show the plugin shape.",
  env: ["EXAMPLE_ENABLED"],
  fromEnv(env) {
    if (!env.EXAMPLE_ENABLED) return undefined;
    return {
      name: "example",
      async collect(scope) {
        return [
          {
            id: "example:hello",
            source: "example",
            kind: "example.note",
            observedAt: scope.to,
            severity: "info",
            summary: `Example connector looked at ${scope.namespace}`,
            subject: { kind: "Namespace", name: scope.namespace },
            tags: [],
            data: {},
          },
        ];
      },
    };
  },
};
