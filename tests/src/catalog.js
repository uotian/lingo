// 公開モデルや単価の更新に影響されない、疑似API用の既知の値。
export const testCatalog = {
  version: 1,
  recommended: "gpt-6-luna",
  models: [
    { id: "gpt-6-luna", label: "Luna", input: 0.1, cached: 0.01, write: 0.125, output: 0.5, reasoningEffort: "none" },
    { id: "gpt-6-sol", label: "Sol", input: 2, cached: 0.2, write: 2.5, output: 10 },
    { id: "gpt-6.1-sol", label: "Sol 6.1", input: 2, cached: 0.1, write: 2.5, output: 10 },
  ],
};
