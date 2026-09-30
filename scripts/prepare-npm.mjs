import { copyFile } from 'node:fs/promises';

await copyFile(
    new URL('../README.md', import.meta.url),
    new URL('../packages/shotx/README.md', import.meta.url)
);
