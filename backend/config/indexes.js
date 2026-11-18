import appointmentModel from '../models/appointmentModel.js'
import refundModel from '../models/refundModel.js'
import slotOrphanModel from '../models/slotOrphanModel.js'

// Indexes the booking / refund safety guarantees depend on. Startup fails unless
// each exists with exactly these options.
export const REQUIRED_INDEXES = [
    {
        model: appointmentModel,
        description: 'one slot-holding appointment per doctor/date/time',
        key: { docId: 1, slotDate: 1, slotTime: 1 },
        unique: true,
        partialFilterExpression: { slotLocked: true }
    },
    {
        model: refundModel,
        description: 'one refund record per Razorpay payment',
        key: { paymentId: 1 },
        unique: true
    }
]

// Indexes created by earlier development builds that the code no longer uses.
// Reported only; never dropped automatically.
export const OBSOLETE_INDEXES = [
    { model: appointmentModel, name: 'refund_reconcile' }
]

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Throws if any required index is missing or has different options.
 */
export const verifyRequiredIndexes = async () => {
    const problems = []
    for (const spec of REQUIRED_INDEXES) {
        const collection = spec.model.collection.collectionName
        let indexes = []
        try {
            indexes = await spec.model.collection.indexes()
        } catch (error) {
            problems.push(`${collection}: cannot list indexes (${error.message})`)
            continue
        }
        const match = indexes.find(index => sameJson(index.key, spec.key))
        if (!match) {
            problems.push(`${collection}: missing index ${JSON.stringify(spec.key)} (${spec.description})`)
        } else if (Boolean(match.unique) !== Boolean(spec.unique)) {
            problems.push(`${collection}: index ${match.name} must be unique (${spec.description})`)
        } else if (!sameJson(match.partialFilterExpression, spec.partialFilterExpression)) {
            problems.push(`${collection}: index ${match.name} has partialFilterExpression ${JSON.stringify(match.partialFilterExpression)}, expected ${JSON.stringify(spec.partialFilterExpression)}`)
        }
    }
    if (problems.length) {
        throw new Error(`Required database indexes are missing or invalid:\n  - ${problems.join('\n  - ')}`)
    }
}

/**
 * Explicitly creates the schema-declared indexes (createIndexes only adds; it
 * never drops anything, unlike syncIndexes) and verifies the required ones.
 * Must complete before the server accepts requests or starts background jobs.
 */
export const ensureRequiredIndexes = async () => {
    for (const model of [appointmentModel, refundModel, slotOrphanModel]) {
        try {
            await model.createCollection().catch(error => {
                if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error
            })
            await model.createIndexes()
        } catch (error) {
            throw new Error(`Creating indexes for collection "${model.collection.collectionName}" failed: ${error.message}`)
        }
    }
    await verifyRequiredIndexes()

    for (const { model, name } of OBSOLETE_INDEXES) {
        const indexes = await model.collection.indexes().catch(() => [])
        if (indexes.some(index => index.name === name)) {
            console.warn(`WARNING: obsolete index "${name}" exists on "${model.collection.collectionName}". It is unused and can be dropped manually after review: db.${model.collection.collectionName}.dropIndex("${name}")`)
        }
    }
    console.log('Required database indexes verified')
}
