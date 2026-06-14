// Standalone DB initializer — used by `npm run init-db` and by setup.sh on a
// fresh Lightsail instance. Creating the schema is idempotent.
import { db, migrate } from './index.js';

migrate();
db.close();
// eslint-disable-next-line no-console
console.log('Acuity Gateway database initialized.');
