// Only for local demo and test PostgreSQL emulation. Production uses pg.Pool.
function embeddedPool(db) {
  let tail = Promise.resolve();
  const query = async (sql, args) => {
    const r = await db.query(sql, args);
    return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  };
  async function connect() {
    const prior = tail;
    let unlock;
    tail = new Promise((r) => (unlock = r));
    await prior;
    let released = false;
    return {
      query,
      release() {
        if (!released) {
          released = true;
          unlock();
        }
      },
    };
  }
  return {
    query: async (sql, args) => {
      const c = await connect();
      try {
        return await c.query(sql, args);
      } finally {
        c.release();
      }
    },
    connect,
    end: async () => {
      await tail;
      await db.close();
    },
  };
}
module.exports = { embeddedPool };
