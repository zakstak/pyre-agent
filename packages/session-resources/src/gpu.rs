//! NVIDIA GPU memory through NVML, loaded at run time so the binary builds and runs without the NVIDIA driver.
//!
//! NVML queries are the same read-only calls `nvidia-smi` makes. Per-process memory covers compute and graphics
//! contexts; other vendors' GPUs are not read.

use libloading::Library;
use std::collections::HashMap;
use std::ffi::{c_int, c_uint, c_void};

type Device = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Memory {
    total: u64,
    free: u64,
    used: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Utilization {
    gpu: c_uint,
    memory: c_uint,
}

/// `nvmlProcessInfo_t`, the layout of the `_v3` process queries.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ProcessInfo {
    pid: c_uint,
    used_gpu_memory: u64,
    gpu_instance_id: c_uint,
    compute_instance_id: c_uint,
}

const SUCCESS: c_int = 0;
const NOT_SUPPORTED: c_int = 3;
const INSUFFICIENT_SIZE: c_int = 7;
/// NVML reports this when per-process memory is not available, as under some virtualization.
const VALUE_NOT_AVAILABLE: u64 = u64::MAX;

type InitFn = unsafe extern "C" fn() -> c_int;
type CountFn = unsafe extern "C" fn(*mut c_uint) -> c_int;
type HandleFn = unsafe extern "C" fn(c_uint, *mut Device) -> c_int;
type MemoryFn = unsafe extern "C" fn(Device, *mut Memory) -> c_int;
type UtilizationFn = unsafe extern "C" fn(Device, *mut Utilization) -> c_int;
type PowerFn = unsafe extern "C" fn(Device, *mut c_uint) -> c_int;
type ProcessesFn = unsafe extern "C" fn(Device, *mut c_uint, *mut ProcessInfo) -> c_int;

/// One reading across all NVIDIA devices.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GpuReading {
    pub vram_used: u64,
    pub vram_total: u64,
    /// Mean utilization across devices, percent.
    pub util_percent: Option<u64>,
    pub power_mw: Option<u64>,
    /// Device memory per process id, summed across devices; `None` for a process whose memory NVML cannot report.
    /// The whole map is `None` when a process list could not be read.
    pub per_pid: Option<HashMap<u32, Option<u64>>>,
}

pub struct Nvml {
    // Keeps the function pointers below valid; dropped last.
    _library: Library,
    shutdown: InitFn,
    memory: MemoryFn,
    utilization: UtilizationFn,
    power: PowerFn,
    compute: ProcessesFn,
    graphics: ProcessesFn,
    devices: Vec<Device>,
}

impl Nvml {
    /// Load and initialize NVML, or explain why GPU memory will not be recorded.
    pub fn open() -> Result<Self, String> {
        // SAFETY: loading the NVIDIA management library runs its initializers, which have no preconditions. Each symbol
        // is cast to the signature documented in nvml.h for that exact versioned name.
        unsafe {
            let library = Library::new("libnvidia-ml.so.1").map_err(|e| format!("NVML not available: {e}"))?;
            let init: InitFn = *library.get(b"nvmlInit_v2\0").map_err(|e| e.to_string())?;
            let shutdown: InitFn = *library.get(b"nvmlShutdown\0").map_err(|e| e.to_string())?;
            let count: CountFn = *library.get(b"nvmlDeviceGetCount_v2\0").map_err(|e| e.to_string())?;
            let handle: HandleFn = *library
                .get(b"nvmlDeviceGetHandleByIndex_v2\0")
                .map_err(|e| e.to_string())?;
            let memory: MemoryFn = *library.get(b"nvmlDeviceGetMemoryInfo\0").map_err(|e| e.to_string())?;
            let utilization: UtilizationFn = *library
                .get(b"nvmlDeviceGetUtilizationRates\0")
                .map_err(|e| e.to_string())?;
            let power: PowerFn = *library.get(b"nvmlDeviceGetPowerUsage\0").map_err(|e| e.to_string())?;
            let compute: ProcessesFn = *library
                .get(b"nvmlDeviceGetComputeRunningProcesses_v3\0")
                .map_err(|e| e.to_string())?;
            let graphics: ProcessesFn = *library
                .get(b"nvmlDeviceGetGraphicsRunningProcesses_v3\0")
                .map_err(|e| e.to_string())?;
            let status = init();
            if status != SUCCESS {
                return Err(format!("nvmlInit failed with status {status}"));
            }
            let mut device_count: c_uint = 0;
            if count(&mut device_count) != SUCCESS {
                shutdown();
                return Err("nvmlDeviceGetCount failed".to_owned());
            }
            let devices = (0..device_count)
                .filter_map(|index| {
                    let mut device: Device = std::ptr::null_mut();
                    (handle(index, &mut device) == SUCCESS).then_some(device)
                })
                .collect();
            Ok(Self {
                _library: library,
                shutdown,
                memory,
                utilization,
                power,
                compute,
                graphics,
                devices,
            })
        }
    }

    pub fn read(&self) -> GpuReading {
        let mut reading = GpuReading::default();
        let mut util_sum = 0;
        let mut util_count = 0;
        let mut power_sum = 0;
        let mut power_count = 0;
        let mut per_pid: HashMap<u32, Option<u64>> = HashMap::new();
        let mut lists_failed = false;
        for &device in &self.devices {
            // SAFETY: each call writes into the local we pass for a device handle NVML returned.
            unsafe {
                let mut memory = Memory::default();
                if (self.memory)(device, &mut memory) == SUCCESS {
                    reading.vram_used += memory.used;
                    reading.vram_total += memory.total;
                }
                let mut util = Utilization::default();
                if (self.utilization)(device, &mut util) == SUCCESS {
                    util_sum += u64::from(util.gpu);
                    util_count += 1;
                }
                let mut milliwatts: c_uint = 0;
                if (self.power)(device, &mut milliwatts) == SUCCESS {
                    power_sum += u64::from(milliwatts);
                    power_count += 1;
                }
            }
            // A process with compute and graphics contexts appears in both lists with the same memory.
            let mut device_pids: HashMap<u32, Option<u64>> = HashMap::new();
            for query in [self.compute, self.graphics] {
                let Some(infos) = processes(query, device) else {
                    lists_failed = true;
                    continue;
                };
                for info in infos {
                    let bytes = (info.used_gpu_memory != VALUE_NOT_AVAILABLE).then_some(info.used_gpu_memory);
                    let entry = device_pids.entry(info.pid).or_insert(bytes);
                    *entry = entry.zip(bytes).map(|(a, b)| a.max(b)).or(entry.or(bytes));
                }
            }
            for (pid, bytes) in device_pids {
                let total = per_pid.entry(pid).or_insert(Some(0));
                *total = total.zip(bytes).map(|(a, b)| a + b);
            }
        }
        // A failed process list leaves per-process memory unknown rather than zero.
        reading.per_pid = (!lists_failed).then_some(per_pid);
        reading.util_percent = (util_count > 0).then(|| util_sum / util_count);
        reading.power_mw = (power_count > 0).then_some(power_sum);
        reading
    }
}

/// The processes using a device, or `None` when NVML could not list them. A list the device does not support, such
/// as graphics processes on a compute-only GPU, is empty.
fn processes(query: ProcessesFn, device: Device) -> Option<Vec<ProcessInfo>> {
    let mut capacity: c_uint = 64;
    loop {
        let mut buffer = vec![ProcessInfo::default(); capacity as usize];
        let mut count = capacity;
        // SAFETY: NVML writes at most `count` entries into a buffer of exactly that many.
        let status = unsafe { query(device, &mut count, buffer.as_mut_ptr()) };
        match status {
            SUCCESS => {
                buffer.truncate(count as usize);
                return Some(buffer);
            }
            NOT_SUPPORTED => return Some(Vec::new()),
            INSUFFICIENT_SIZE if capacity < 4096 => capacity = count.max(capacity * 2),
            _ => return None,
        }
    }
}

impl Drop for Nvml {
    fn drop(&mut self) {
        // SAFETY: balances the successful nvmlInit in `open`.
        unsafe {
            (self.shutdown)();
        }
    }
}
