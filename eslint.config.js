import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // docs/ and bench/ are dependency-isolated sub-projects with their own
    // toolchains; the root lint run covers the library only.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'docs/**',
      'bench/**',
    ],
  },
  ...tseslint.configs.recommended,
  // Prettier owns formatting; disable any formatting-related lint rules.
  prettier,
);
