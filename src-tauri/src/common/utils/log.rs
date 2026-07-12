/// Debug log macro: only outputs to stderr in debug builds.
/// In release builds, it's compiled to nothing (zero overhead).
///
/// Usage: `dbg_log!("...")` or `dbg_log!("{:?}", val)`
#[macro_export]
macro_rules! dbg_log {
    ($($arg:tt)*) => {
        #[cfg(debug_assertions)]
        {
            eprintln!($($arg)*);
        }
    };
}
