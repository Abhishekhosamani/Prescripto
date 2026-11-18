// Production detection shared by the database and CORS configuration.
// Render sets RENDER=true on its services; NODE_ENV=production covers other hosts.
export const isProduction = () =>
    process.env.NODE_ENV === 'production' || String(process.env.RENDER || '').toLowerCase() === 'true'

// Local development / tests default to the separate test database.
export const LOCAL_DEFAULT_DB_NAME = 'prescripto_test'

/**
 * Database name to connect to. Production must name it explicitly
 * (MONGODB_DB_NAME=prescripto); it never falls back to the local test database.
 */
export const resolveDatabaseName = () => {
    const explicit = String(process.env.MONGODB_DB_NAME || '').trim()
    if (explicit) return explicit
    if (isProduction()) {
        throw new Error('MONGODB_DB_NAME is not set. Production requires an explicit database name (e.g. MONGODB_DB_NAME=prescripto); refusing to fall back to the local test database.')
    }
    return LOCAL_DEFAULT_DB_NAME
}
