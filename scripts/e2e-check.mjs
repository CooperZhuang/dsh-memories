import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('C:/Users/<user>/.dsh/memories/state.db')
console.log('sessions:', JSON.stringify(db.prepare('SELECT id, last_seq, contributed, activity_at FROM sessions').all()))
console.log('jobs:', JSON.stringify(db.prepare('SELECT key, retries, last_error FROM jobs').all()))
db.close()