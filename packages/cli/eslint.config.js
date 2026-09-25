import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    ignores: ["dist/**", "node_modules/**", "*.js"],
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.scripts.json"],
      },
    },
    rules: {
      // TypeScript strict rules
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/strict-boolean-expressions": "off",
      "@typescript-eslint/no-inferrable-types": "off",

      // General rules
      "no-console": "off",
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    files: ["scripts/**/*.ts"],
    rules: {
      // The migrated maintenance scripts receive semantic checks from their
      // dedicated tsconfig; relax style-only strictness while their API types
      // are added in focused follow-up edits.
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
    },
  },
];
