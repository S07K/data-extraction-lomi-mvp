import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/** Shared flat config for every workspace package. */
export default tseslint.config(
  { ignores: ["dist/**", ".next/**", "src/generated/**", "coverage/**", "next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
);
