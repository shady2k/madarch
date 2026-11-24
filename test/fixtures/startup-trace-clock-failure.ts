/** Force the real shared-clock sample to fail without a production feature switch. */
const ffiModule = require('bun:ffi') as typeof import('bun:ffi');
const originalDlopen = ffiModule.dlopen;
ffiModule.dlopen = ((...args: Parameters<typeof ffiModule.dlopen>) => {
 const library = originalDlopen(...args);
 return { ...library, symbols: { ...library.symbols, clock_gettime: () => -1 } };
}) as unknown as typeof ffiModule.dlopen;
