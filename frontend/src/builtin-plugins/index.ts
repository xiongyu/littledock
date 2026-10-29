// Bundled plugins use the same frontend SDK. The host shell does not import business pages.
import.meta.glob('./*/index.ts', { eager: true })
