import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import sonar from "./eslint-sonar.config.mjs";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "coverage/**", ".scannerwork/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ["scripts/**/*.cjs"], rules: { "@typescript-eslint/no-require-imports": "off" } },
  sonar,
);
