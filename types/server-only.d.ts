// Local type shim so `import "server-only"` type-checks even when the package
// isn't installed in a constrained dev environment. The real `server-only`
// package (in dependencies) provides the build-time client-bundle guard on
// Vercel; this declaration is harmless alongside it.
declare module "server-only";
