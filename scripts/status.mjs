#!/usr/bin/node
import * as fs from 'node:fs/promises';
import { exec } from "node:child_process";
import { promisify } from 'node:util';

const UPDATE_INTERVAL = 1000;
const NET_INTERFACE = "wlp3s0";
// Should return float where 0 means 0% and 1 means 100% and negative means muted.
const GET_VOLUME_FN = () => {
  return new Promise((resolve, reject) => {
    exec("wpctl get-volume @DEFAULT_AUDIO_SINK@", (err, stdout) => {
      if (err) return reject(err);
      let vol = parseFloat(stdout.split(" ")[1]);
      if (stdout.includes("MUTED")) {
        vol = -1.0;
      }
      return resolve(vol);
    });
  });
};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getTime() {
  return new Date().toLocaleTimeString();
}

async function getMemInfo() {
  const memInfo = await fs.readFile("/proc/meminfo")
    .then(x => x.toString('utf-8'))
    .then(x => x.split("\n"))
    .then(x => x.reduce((acc, curr) => {
      const splitted = curr.split(/\s+/);
      const key = splitted[0].substring(0, splitted[0].length - 1);
      if (key == "") return acc;
      const val = splitted[1];
      acc[key] = parseInt(val);
      return acc;
    }, {}));
  
  return memInfo;
}

async function getCpuStat() {
  const stat = await fs.readFile("/proc/stat")
    .then(x => x.toString('utf-8'))
    .then(x => x.split("\n"));
  
  const cpuStat = stat.filter(line => line.startsWith("cpu"))[0]
    .split(/\s+/)
    .slice(1)
    .map(x => parseInt(x));

  return {
    user: cpuStat[0],
    nice: cpuStat[1],
    system: cpuStat[2],
    idle: cpuStat[3],
    iowait: cpuStat[4],
    irq: cpuStat[5],
    softirq: cpuStat[6],
    steal: cpuStat[7],
    guest: cpuStat[8],
    guestNice: cpuStat[9]
  };
}

let lastCpuStat;

async function getCpuStatDiff() {
  const cpuStat = await getCpuStat();
  if (!lastCpuStat) {
    lastCpuStat = cpuStat;
  }

  const ret = {
    user: cpuStat.user - lastCpuStat.user,
    nice: cpuStat.nice - lastCpuStat.nice,
    system: cpuStat.system - lastCpuStat.system,
    idle: cpuStat.idle - lastCpuStat.idle,
    iowait: cpuStat.iowait - lastCpuStat.iowait,
    irq: cpuStat.irq - lastCpuStat.irq,
    softirq: cpuStat.softirq - lastCpuStat.softirq,
    steal: cpuStat.steal - lastCpuStat.steal,
    guest: cpuStat.guest - lastCpuStat.guest,
    guestNice: cpuStat.guestNice - lastCpuStat.guestNice
  };

  lastCpuStat = cpuStat;
  return ret;
}

function sumCpuStat(c) {
  return c.user + c.nice + c.system + c.idle + c.iowait + c.irq + c.softirq + c.steal + c.guest + c.guestNice;
}

function sumCpuIdle(c) {
  return c.idle + c.iowait;
}

function sumCpuUsage(c) {
  return sumCpuStat(c) - sumCpuIdle(c);
}

async function getBatteryInfo() {
  try {
    await fs.stat("/sys/class/power_supply/BAT0")
  }
  catch {
    // In case we have no battery, just return null
    return null;
  }

  const [ status, capacity, energyFull, energyNow ] = await Promise.all([
    fs.readFile("/sys/class/power_supply/BAT0/status").then(x => x.toString("utf-8")),
    fs.readFile("/sys/class/power_supply/BAT0/capacity").then(x => x.toString("utf-8")).then(parseInt),
    fs.readFile("/sys/class/power_supply/BAT0/energy_full").then(x => x.toString("utf-8")).then(parseInt),
    fs.readFile("/sys/class/power_supply/BAT0/energy_now").then(x => x.toString("utf-8")).then(parseInt)
  ]);

  return { status, capacity, energyFull, energyNow };
}

let lastNetworkStats;
let lastNetworkStatsTimestamp = 0;

async function getNetworkStats() {
  try {
    await fs.stat(`/sys/class/net/${NET_INTERFACE}`);
  }
  catch {
    // Network interface doesn't exists
    return null;
  }

  const [txBytes, rxBytes] = await Promise.all([
    fs.readFile(`/sys/class/net/${NET_INTERFACE}/statistics/tx_bytes`).then(x => parseInt(x.toString("utf-8"))),
    fs.readFile(`/sys/class/net/${NET_INTERFACE}/statistics/rx_bytes`).then(x => parseInt(x.toString("utf-8")))
  ]);

  const networkStats = { txBytes, rxBytes, txSpeed: 0, rxSpeed: 0 };
  const now = Date.now();

  if (lastNetworkStats && lastNetworkStatsTimestamp) {
    const elapsedSec = (now - lastNetworkStatsTimestamp) / 1000;
    const txDelta = networkStats.txBytes - lastNetworkStats.txBytes;
    const rxDelta = networkStats.rxBytes - lastNetworkStats.rxBytes;
    networkStats.txSpeed = Math.floor(txDelta / elapsedSec);
    networkStats.rxSpeed = Math.floor(rxDelta / elapsedSec);
  }

  lastNetworkStats = networkStats;
  lastNetworkStatsTimestamp = now;
  return networkStats;
}

function numberToDataUnit(bytes) {
  let result = bytes;
  let unitIdx = 0;
  const units = [ "B", "K", "M", "G", "T" ];
  
  
  while (result > 1024) {
    result /= 1024;
    unitIdx++;
    if (unitIdx == (units.length - 1)) {
      break;
    }
  }
  
  let precision = 2;
  
  // To save some space on screen I will reduce precision for big numbers.
  if (result >= 10) {
    precision = 1;
  }
  if (result >= 100) {
    precision = 0;
  }

  result = Math.round(result * 10 ** precision) / 10 ** precision;

  return `${result}${units[unitIdx]}`;
}

/**
  * @param { { txBytes: number, rxBytes: number, txSpeed: number, rxSpeed: number } } ns
  */
function formatNetworkStats(ns) {
  return {
    tx: numberToDataUnit(ns.txBytes),
    rx: numberToDataUnit(ns.rxBytes),
    txSpeed: numberToDataUnit(ns.txSpeed) + "/s",
    rxSpeed: numberToDataUnit(ns.rxSpeed) + "/s"
  };
}

async function getStatus() {
  const [ networkStats, batteryInfo, cpuStatDelta, memInfo, volume ] = await Promise.all([
    getNetworkStats(),
    getBatteryInfo(),
    getCpuStatDiff(),
    getMemInfo(),
    GET_VOLUME_FN()
  ]);

  const time = getTime();
  
  const memUsage = memInfo["MemTotal"] - memInfo["MemAvailable"];
  const memUsagePercentage = Math.round(memUsage / memInfo["MemTotal"] * 100);

  const cpuTotal = sumCpuStat(cpuStatDelta);
  const cpuUsage = sumCpuUsage(cpuStatDelta);
  const cpuUsagePercentage = cpuTotal > 0 ? Math.round(cpuUsage / cpuTotal * 100) : 0;
  const ioWaitPercentage = cpuTotal > 0 ? Math.round(cpuStatDelta.iowait / cpuTotal * 100) : 0;


  let final = [];

  if (networkStats) {
    const formatted = formatNetworkStats(networkStats);

    final.push(`󰕒 ${formatted.txSpeed} (${formatted.tx}) 󰇚 ${formatted.rxSpeed} (${formatted.rx})`);
  }

  if (batteryInfo) {
    let icons = "󰂎 󰁺 󰁻 󰁼 󰁽 󰁾 󰁿 󰂀 󰂁 󰂂 󰁹".split(" ");
    let chargingIcons = "󰢟 󰢜 󰂆 󰂇 󰂈 󰢝 󰂉 󰢞 󰂊 󰂋 󰂅".split(" ");
    let icon = icons[Math.round(batteryInfo.capacity / 10)];


    if (batteryInfo.status.startsWith("Charging")) {
      icon = chargingIcons[Math.round(batteryInfo.capacity / 10)];
    }
    if (batteryInfo.status == "Full") {
      icon = "󰚥"
    }

    final.push(`${icon} ${batteryInfo.capacity}%`);
  }

  final.push(` ${cpuUsagePercentage}%`);
  // final.push(`IO_WAIT: ${ioWaitPercentage}%`);
  final.push(` ${memUsagePercentage}%`);
  
  if (volume > 0) {
    final.push(` ${Math.floor(volume * 100)}%`);
  } else {
    final.push(` MUTED`);
  }

  final.push(`${time}`);

  return final.join(" | ");
}

while (true) {
  const status = await getStatus().catch(err => err.toString());
  await promisify(exec)(`xsetroot -name " ${status} "`).catch(err => console.error(err));
  await delay(UPDATE_INTERVAL);
}
