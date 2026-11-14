"use strict";
const fs = require("fs");
const path = require("path");

// Reconnect periods may contain audio only. Keep elementary tracks independent
// so an absent picture becomes a timestamp gap rather than dropped audio.
module.exports = async function muxTimelineTracks({ periods, directory, temporary, run, packetCounts, samePackets, preset, diagnostics }) {
  const generated = [], entries = { video: [], audio: [] }, leading = { video: 0, audio: 0 }, expected = { video: 0, audio: 0 }, signatures = {};
  const inspect = async file => JSON.parse(await run(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));
  diagnostics.method = "separate_tracks"; diagnostics.periods = [];
  try {
    for (const [index, period] of periods.entries()) {
      const input = path.join(directory, `timeline-track-source-${index}.m3u8`); generated.push(input);
      fs.writeFileSync(input, period.local, { mode: 0o600 });
      const source = await packetCounts(input, true), present = {};
      if (source.filter(s => s.type === "audio").length > 1) throw preset("音频独立时间轴暂不支持多音轨，原录像已保留");
      let duration = period.seconds;
      const measured = { manifestSeconds: period.seconds, segments: period.segments, sourcePackets: source, outputPackets: [] };
      diagnostics.periods.push(measured);
      for (const type of ["video", "audio"]) {
        const stream = source.find(s => s.type === type); if (!stream) continue;
        const name = `timeline-track-${type}-${index}.mp4`, output = path.join(directory, name); generated.push(output);
        await run(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-y", "-protocol_whitelist", "file,crypto,data", "-allowed_extensions", "ALL", "-copyts", "-start_at_zero", "-i", input, "-map", type === "video" ? "0:v:0" : "0:a:0", "-c", "copy", ...(type === "video" ? ["-bsf:v", "setts=duration='max(DURATION,1)'"] : []), output]);
        const packets = await packetCounts(output), info = await inspect(output);
        if (!samePackets([stream], packets)) throw preset("独立音视频轨道的媒体包数量不符，原录像已保留");
        const signature = JSON.stringify(info.streams.map(({ codec_type, codec_name, width, height, sample_rate, channels }) => ({ codec_type, codec_name, width, height, sample_rate, channels })));
        if (signatures[type] && signatures[type] !== signature) throw preset("官方回放中途画面或音轨格式变化，原录像已保留");
        signatures[type] = signature;
        measured.outputPackets.push(...packets); expected[type] += stream.packets;
        duration = Math.max(duration, Number(info.format.duration)); present[type] = { name, duration };
      }
      measured.durationSeconds = duration;
      if (Math.abs(duration - period.seconds) > Math.max(2, period.seconds * 0.002, Math.min(period.maximum + 0.5, period.seconds * 0.01))) throw preset("独立音视频时间轴时长与官方清单不符，原录像已保留");
      for (const type of ["video", "audio"]) {
        if (present[type]) entries[type].push({ name: present[type].name, duration });
        else if (entries[type].length) entries[type].at(-1).duration += duration;
        else leading[type] += duration;
      }
    }
    if (!entries.video.length) throw preset("视频缺少有效画面，原录像已保留");
    const inputs = [], maps = []; let inputIndex = 0;
    for (const type of ["video", "audio"]) {
      if (!entries[type].length) continue;
      const list = path.join(directory, `timeline-track-${type}.ffconcat`); generated.push(list);
      fs.writeFileSync(list, "ffconcat version 1.0\n" + entries[type].map(e => `file '${e.name}'\ninpoint 0\nduration ${e.duration}`).join("\n") + "\n", { mode: 0o600 });
      inputs.push("-itsoffset", String(leading[type]), "-f", "concat", "-safe", "0", "-i", list);
      maps.push("-map", `${inputIndex++}:${type === "video" ? "v" : "a"}:0`);
    }
    await run(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-y", ...inputs, ...maps, "-c", "copy", "-bsf:v", "setts=duration='max(DURATION,1)'", "-movflags", "+faststart", temporary]);
    const actual = await packetCounts(temporary), expectedPackets = ["video", "audio"].filter(type => expected[type] > 0).map(type => ({ type, packets: expected[type] }));
    if (!samePackets(expectedPackets, actual)) throw preset("音视频重新合并后媒体包数量不符，原录像已保留");
    const info = await inspect(temporary), total = periods.reduce((s, _, i) => s + diagnostics.periods[i].durationSeconds, 0);
    if (Math.abs(Number(info.format.duration) - total) > Math.max(2, total * 0.002)) throw preset("音视频重新合并后时长不符，原录像已保留");
    diagnostics.durationSeconds = Number(info.format.duration); diagnostics.expectedPackets = expectedPackets; diagnostics.actualPackets = actual;
    diagnostics.audioOnlySeconds = periods.reduce((s, _, i) => s + (diagnostics.periods[i].sourcePackets.some(p => p.type === "video") ? 0 : diagnostics.periods[i].durationSeconds), 0);
    return info;
  } finally { for (const file of generated) { try { fs.unlinkSync(file); } catch {} } }
};
