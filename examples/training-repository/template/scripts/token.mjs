// Prints an HS256 token for the demo customer, valid for one hour.
// Usage: JWT_SECRET=... node scripts/token.mjs [customer-id] [role]
import { createHmac } from 'node:crypto';

const secret = process.env.JWT_SECRET ?? 'local-development-secret';
const [customer = 'demo', role = 'customer'] = process.argv.slice(2);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

const header = encode({ alg: 'HS256', typ: 'JWT' });
const payload = encode({ sub: customer, role, exp: Math.floor(Date.now() / 1000) + 3600 });
const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
console.log(`${header}.${payload}.${signature}`);
