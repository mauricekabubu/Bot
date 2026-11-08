const validUser = (userId) => typeof userId === 'string' && /^\d+@c\.us$/.test(userId);
const MAX_DELIVERY_ATTEMPTS = 3;

export class ReminderService {
  constructor(db, notify) {
    if (!db || typeof notify !== 'function') throw new Error('Reminder database and delivery function are required.');
    this.db = db;
    this.notify = notify;
    this.tickPromise = null;
  }

  create(userId, text, dueAt) {
    if (!validUser(userId)) throw new Error('Invalid reminder recipient.');
    if (typeof text !== 'string' || !text.trim() || text.length > 500) {
      throw new Error('Invalid reminder text.');
    }

    let due;
    try {
      due = new Date(dueAt);
    } catch {
      throw new Error('Please give a valid future reminder date and time.');
    }
    if (Number.isNaN(due.getTime()) || due <= new Date()) {
      throw new Error('Please give a future reminder date and time.');
    }

    return this.db.prepare(
      'INSERT INTO reminders(user_id,text,due_at,created_at) VALUES(?,?,?,?)',
    ).run(userId, text.trim(), due.toISOString(), new Date().toISOString());
  }

  list(userId) {
    if (!validUser(userId)) throw new Error('Invalid reminder recipient.');
    return this.db.prepare(
      'SELECT id,text,due_at,completed FROM reminders WHERE user_id=? ORDER BY due_at',
    ).all(userId);
  }

  complete(userId, id) {
    const reminderId = Number(id);
    if (!validUser(userId) || !Number.isSafeInteger(reminderId) || reminderId < 1) {
      throw new Error('Invalid reminder request.');
    }
    return this.db.prepare(
      'UPDATE reminders SET completed=1 WHERE id=? AND user_id=?',
    ).run(reminderId, userId).changes > 0;
  }

  async tick() {
    if (this.tickPromise) return this.tickPromise;
    const currentTick = this.deliverDueReminders();
    this.tickPromise = currentTick;
    try {
      return await currentTick;
    } finally {
      if (this.tickPromise === currentTick) this.tickPromise = null;
    }
  }

  async deliverDueReminders() {
    const due = this.db.prepare(
      `SELECT id,user_id,text,delivery_attempts FROM reminders
       WHERE completed=0 AND notified=0 AND due_at <= ?
         AND delivery_attempts < ?
         AND (last_error IS NULL OR last_error NOT LIKE 'SEND_RESULT_UNCERTAIN%')
       ORDER BY due_at,id`,
    ).all(new Date().toISOString(), MAX_DELIVERY_ATTEMPTS);
    const failures = [];

    for (const reminder of due) {
      try {
        if (!validUser(reminder.user_id)) throw new Error('Invalid individual WhatsApp recipient.');
        const result = await this.notify(
          reminder.user_id,
          `⏰ Reminder: ${reminder.text}`,
          { reminderId: reminder.id, attempt: Number(reminder.delivery_attempts || 0) + 1 },
        );
        if (result === false || result?.accepted === false) {
          throw Object.assign(new Error('Known pre-acceptance failure.'), { retryable: true });
        }
        if (result?.accepted !== true && result !== true) {
          throw Object.assign(new Error('The WhatsApp send result is uncertain.'), { uncertain: true });
        }
        this.db.prepare(
          'UPDATE reminders SET notified=1,last_error=NULL WHERE id=? AND completed=0 AND notified=0',
        ).run(reminder.id);
      } catch (error) {
        const errorMessage = error?.uncertain
          ? 'SEND_RESULT_UNCERTAIN: reminder will not be resent automatically.'
          : 'WhatsApp delivery failed; retry is bounded.';
        this.db.prepare(
          'UPDATE reminders SET delivery_attempts=delivery_attempts+1,last_error=? WHERE id=? AND notified=0',
        ).run(errorMessage, reminder.id);
        failures.push({ id: reminder.id });
      }
    }

    return failures;
  }
}
