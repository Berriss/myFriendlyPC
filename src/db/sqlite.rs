use anyhow::{anyhow, Context, Result};
use libc::{c_char, c_int, c_void};
use parking_lot::Mutex;
use std::ffi::{CStr, CString};
use std::marker::PhantomData;
use std::path::Path;
use std::ptr;
use std::sync::Arc;

const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_DONE: c_int = 101;
const SQLITE_NULL: c_int = 5;

const SQLITE_OPEN_READWRITE: c_int = 0x0000_0002;
const SQLITE_OPEN_CREATE: c_int = 0x0000_0004;
const SQLITE_OPEN_FULLMUTEX: c_int = 0x0001_0000;

const SQLITE_TRANSIENT: isize = -1;

#[repr(C)]
struct Sqlite3 {
    _private: [u8; 0],
}

#[repr(C)]
struct Sqlite3Stmt {
    _private: [u8; 0],
}

#[link(name = "sqlite3")]
extern "C" {
    fn sqlite3_open_v2(
        filename: *const c_char,
        pp_db: *mut *mut Sqlite3,
        flags: c_int,
        z_vfs: *const c_char,
    ) -> c_int;
    fn sqlite3_close_v2(db: *mut Sqlite3) -> c_int;
    fn sqlite3_errmsg(db: *mut Sqlite3) -> *const c_char;
    fn sqlite3_exec(
        db: *mut Sqlite3,
        sql: *const c_char,
        callback: *const c_void,
        arg: *mut c_void,
        errmsg: *mut *mut c_char,
    ) -> c_int;
    fn sqlite3_free(ptr: *mut c_void);

    fn sqlite3_prepare_v2(
        db: *mut Sqlite3,
        z_sql: *const c_char,
        n_byte: c_int,
        pp_stmt: *mut *mut Sqlite3Stmt,
        pz_tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_step(stmt: *mut Sqlite3Stmt) -> c_int;
    fn sqlite3_finalize(stmt: *mut Sqlite3Stmt) -> c_int;

    fn sqlite3_bind_null(stmt: *mut Sqlite3Stmt, idx: c_int) -> c_int;
    fn sqlite3_bind_int64(stmt: *mut Sqlite3Stmt, idx: c_int, val: i64) -> c_int;
    fn sqlite3_bind_double(stmt: *mut Sqlite3Stmt, idx: c_int, val: f64) -> c_int;
    fn sqlite3_bind_text(
        stmt: *mut Sqlite3Stmt,
        idx: c_int,
        val: *const c_char,
        n_bytes: c_int,
        destructor: isize,
    ) -> c_int;

    fn sqlite3_column_type(stmt: *mut Sqlite3Stmt, i_col: c_int) -> c_int;
    fn sqlite3_column_int64(stmt: *mut Sqlite3Stmt, i_col: c_int) -> i64;
    fn sqlite3_column_double(stmt: *mut Sqlite3Stmt, i_col: c_int) -> f64;
    fn sqlite3_column_text(stmt: *mut Sqlite3Stmt, i_col: c_int) -> *const u8;
    fn sqlite3_column_bytes(stmt: *mut Sqlite3Stmt, i_col: c_int) -> c_int;
    fn sqlite3_changes(db: *mut Sqlite3) -> c_int;
    fn sqlite3_last_insert_rowid(db: *mut Sqlite3) -> i64;
}

/// Bindable SQL parameter values.
#[derive(Debug, Clone)]
pub enum SqlValue {
    Null,
    Int64(i64),
    Float64(f64),
    Text(String),
}

impl From<i64> for SqlValue {
    fn from(v: i64) -> Self {
        Self::Int64(v)
    }
}

impl From<i32> for SqlValue {
    fn from(v: i32) -> Self {
        Self::Int64(i64::from(v))
    }
}

impl From<bool> for SqlValue {
    fn from(v: bool) -> Self {
        Self::Int64(if v { 1 } else { 0 })
    }
}

impl From<f64> for SqlValue {
    fn from(v: f64) -> Self {
        Self::Float64(v)
    }
}

impl From<String> for SqlValue {
    fn from(v: String) -> Self {
        Self::Text(v)
    }
}

impl From<&str> for SqlValue {
    fn from(v: &str) -> Self {
        Self::Text(v.to_owned())
    }
}

impl<T: Into<SqlValue>> From<Option<T>> for SqlValue {
    fn from(v: Option<T>) -> Self {
        match v {
            Some(inner) => inner.into(),
            None => Self::Null,
        }
    }
}

struct RawConnection {
    handle: *mut Sqlite3,
}

// SQLite connection is serialized behind a Mutex and opened with SQLITE_OPEN_FULLMUTEX.
unsafe impl Send for RawConnection {}

impl Drop for RawConnection {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                sqlite3_close_v2(self.handle);
            }
            self.handle = ptr::null_mut();
        }
    }
}

impl RawConnection {
    fn last_error(&self) -> String {
        unsafe {
            let msg_ptr = sqlite3_errmsg(self.handle);
            if msg_ptr.is_null() {
                "unknown sqlite error".to_string()
            } else {
                CStr::from_ptr(msg_ptr).to_string_lossy().into_owned()
            }
        }
    }

    fn exec_batch(&self, sql: &str) -> Result<()> {
        let c_sql = CString::new(sql).context("SQL contains interior NUL byte")?;
        let mut errmsg: *mut c_char = ptr::null_mut();
        let rc = unsafe {
            sqlite3_exec(
                self.handle,
                c_sql.as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                &mut errmsg,
            )
        };
        if rc != SQLITE_OK {
            let msg = if !errmsg.is_null() {
                let s = unsafe { CStr::from_ptr(errmsg).to_string_lossy().into_owned() };
                unsafe { sqlite3_free(errmsg.cast::<c_void>()) };
                s
            } else {
                self.last_error()
            };
            return Err(anyhow!("SQLite batch error ({rc}): {msg}"));
        }
        Ok(())
    }

    fn prepare_and_bind(&self, sql: &str, params: &[SqlValue]) -> Result<StmtGuard<'_>> {
        let mut stmt: *mut Sqlite3Stmt = ptr::null_mut();
        let bytes = sql.as_bytes();
        let rc = unsafe {
            sqlite3_prepare_v2(
                self.handle,
                bytes.as_ptr().cast::<c_char>(),
                bytes.len() as c_int,
                &mut stmt,
                ptr::null_mut(),
            )
        };
        if rc != SQLITE_OK || stmt.is_null() {
            return Err(anyhow!(
                "SQLite prepare error ({rc}): {} | SQL: {sql}",
                self.last_error()
            ));
        }

        let guard = StmtGuard {
            _marker: PhantomData,
            stmt,
        };
        for (i, param) in params.iter().enumerate() {
            let idx = (i + 1) as c_int;
            let bind_rc = match param {
                SqlValue::Null => unsafe { sqlite3_bind_null(stmt, idx) },
                SqlValue::Int64(v) => unsafe { sqlite3_bind_int64(stmt, idx, *v) },
                SqlValue::Float64(v) => unsafe { sqlite3_bind_double(stmt, idx, *v) },
                SqlValue::Text(s) => {
                    let sb = s.as_bytes();
                    unsafe {
                        sqlite3_bind_text(
                            stmt,
                            idx,
                            sb.as_ptr().cast::<c_char>(),
                            sb.len() as c_int,
                            SQLITE_TRANSIENT,
                        )
                    }
                }
            };
            if bind_rc != SQLITE_OK {
                return Err(anyhow!(
                    "SQLite bind error on param {idx} ({bind_rc}): {}",
                    self.last_error()
                ));
            }
        }

        Ok(guard)
    }
}

struct StmtGuard<'a> {
    _marker: PhantomData<&'a RawConnection>,
    stmt: *mut Sqlite3Stmt,
}

impl Drop for StmtGuard<'_> {
    fn drop(&mut self) {
        if !self.stmt.is_null() {
            unsafe {
                sqlite3_finalize(self.stmt);
            }
            self.stmt = ptr::null_mut();
        }
    }
}

/// Borrowed view over the current SQLite result row.
pub struct Row {
    stmt: *mut Sqlite3Stmt,
}

impl Row {
    pub fn is_null(&self, col: usize) -> bool {
        unsafe { sqlite3_column_type(self.stmt, col as c_int) == SQLITE_NULL }
    }

    pub fn get_i64(&self, col: usize) -> i64 {
        unsafe { sqlite3_column_int64(self.stmt, col as c_int) }
    }

    pub fn get_opt_i64(&self, col: usize) -> Option<i64> {
        if self.is_null(col) {
            None
        } else {
            Some(self.get_i64(col))
        }
    }

    pub fn get_f64(&self, col: usize) -> f64 {
        unsafe { sqlite3_column_double(self.stmt, col as c_int) }
    }

    pub fn get_opt_f64(&self, col: usize) -> Option<f64> {
        if self.is_null(col) {
            None
        } else {
            Some(self.get_f64(col))
        }
    }

    pub fn get_bool(&self, col: usize) -> bool {
        self.get_i64(col) != 0
    }

    pub fn get_string(&self, col: usize) -> String {
        self.get_opt_string(col).unwrap_or_default()
    }

    pub fn get_opt_string(&self, col: usize) -> Option<String> {
        if self.is_null(col) {
            return None;
        }
        unsafe {
            let ptr = sqlite3_column_text(self.stmt, col as c_int);
            if ptr.is_null() {
                return None;
            }
            let len = sqlite3_column_bytes(self.stmt, col as c_int) as usize;
            let slice = std::slice::from_raw_parts(ptr, len);
            Some(String::from_utf8_lossy(slice).into_owned())
        }
    }
}

/// Thread-safe handle to a local SQLite 3 database.
#[derive(Clone)]
pub struct Database {
    inner: Arc<Mutex<RawConnection>>,
}

impl Database {
    /// Open (or create) a SQLite database file and apply safe runtime pragmas.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let path_ref = path.as_ref();
        if let Some(parent) = path_ref.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let path_str = path_ref
            .to_str()
            .ok_or_else(|| anyhow!("Database path is not valid UTF-8"))?;
        let c_path = CString::new(path_str)?;

        let mut handle: *mut Sqlite3 = ptr::null_mut();
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX;
        let rc = unsafe { sqlite3_open_v2(c_path.as_ptr(), &mut handle, flags, ptr::null()) };
        if rc != SQLITE_OK || handle.is_null() {
            let msg = if !handle.is_null() {
                let s = unsafe { CStr::from_ptr(sqlite3_errmsg(handle)).to_string_lossy().into_owned() };
                unsafe { sqlite3_close_v2(handle) };
                s
            } else {
                "failed to allocate sqlite3 handle".to_string()
            };
            return Err(anyhow!("Failed to open SQLite database at {path_str}: {msg}"));
        }

        let conn = RawConnection { handle };
        conn.exec_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )?;

        Ok(Self {
            inner: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn execute_batch(&self, sql: &str) -> Result<()> {
        let conn = self.inner.lock();
        conn.exec_batch(sql)
    }

    pub fn execute(&self, sql: &str, params: &[SqlValue]) -> Result<usize> {
        let conn = self.inner.lock();
        execute_on_conn(&conn, sql, params)
    }

    pub fn query_map<T, F>(&self, sql: &str, params: &[SqlValue], mut mapper: F) -> Result<Vec<T>>
    where
        F: FnMut(&Row) -> Result<T>,
    {
        let conn = self.inner.lock();
        query_map_on_conn(&conn, sql, params, &mut mapper)
    }

    pub fn query_row_opt<T, F>(
        &self,
        sql: &str,
        params: &[SqlValue],
        mut mapper: F,
    ) -> Result<Option<T>>
    where
        F: FnMut(&Row) -> Result<T>,
    {
        let conn = self.inner.lock();
        let rows = query_map_on_conn(&conn, sql, params, &mut mapper)?;
        Ok(rows.into_iter().next())
    }

    pub fn with_transaction<T, F>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Transaction<'_>) -> Result<T>,
    {
        let conn = self.inner.lock();
        conn.exec_batch("BEGIN IMMEDIATE;")?;
        let tx = Transaction { conn: &conn };
        match f(&tx) {
            Ok(val) => {
                conn.exec_batch("COMMIT;")?;
                Ok(val)
            }
            Err(err) => {
                let _ = conn.exec_batch("ROLLBACK;");
                Err(err)
            }
        }
    }
}

/// Active SQLite write transaction holding the connection mutex.
pub struct Transaction<'a> {
    conn: &'a RawConnection,
}

impl Transaction<'_> {
    pub fn execute(&self, sql: &str, params: &[SqlValue]) -> Result<usize> {
        execute_on_conn(self.conn, sql, params)
    }

    pub fn last_insert_rowid(&self) -> i64 {
        unsafe { sqlite3_last_insert_rowid(self.conn.handle) }
    }
}

fn execute_on_conn(conn: &RawConnection, sql: &str, params: &[SqlValue]) -> Result<usize> {
    let guard = conn.prepare_and_bind(sql, params)?;
    let rc = unsafe { sqlite3_step(guard.stmt) };
    if rc != SQLITE_DONE && rc != SQLITE_ROW {
        return Err(anyhow!(
            "SQLite step error ({rc}): {} | SQL: {sql}",
            conn.last_error()
        ));
    }
    let changes = unsafe { sqlite3_changes(conn.handle) };
    Ok(changes.max(0) as usize)
}

fn query_map_on_conn<T, F>(
    conn: &RawConnection,
    sql: &str,
    params: &[SqlValue],
    mapper: &mut F,
) -> Result<Vec<T>>
where
    F: FnMut(&Row) -> Result<T>,
{
    let guard = conn.prepare_and_bind(sql, params)?;
    let mut results = Vec::new();
    loop {
        let rc = unsafe { sqlite3_step(guard.stmt) };
        match rc {
            SQLITE_ROW => {
                let row = Row { stmt: guard.stmt };
                results.push(mapper(&row)?);
            }
            SQLITE_DONE => break,
            other => {
                return Err(anyhow!(
                    "SQLite query step error ({other}): {} | SQL: {sql}",
                    conn.last_error()
                ));
            }
        }
    }
    Ok(results)
}
