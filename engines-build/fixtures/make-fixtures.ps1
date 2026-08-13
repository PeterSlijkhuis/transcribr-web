# engines-build/fixtures/make-fixtures.ps1
# Synthesizes two small, license-free WAV fixtures via Windows SAPI
# text-to-speech: single-speaker.wav (one voice, known text) and
# two-speaker.wav (two voices, 1s silence gap). Both 16kHz/16-bit/mono.
# Run once locally; the output wavs are committed to git (a few hundred
# KB total), never regenerated in CI (SAPI is Windows-only).
Add-Type -AssemblyName System.Speech

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$voices = (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() |
    Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }
if ($voices.Count -lt 2) {
    throw "Need at least 2 installed SAPI voices, found: $($voices -join ', ')"
}
$voiceA = $voices[0]
$voiceB = $voices[1]
Write-Host "voiceA=$voiceA voiceB=$voiceB"

function Speak-ToWav([string]$voice, [string]$text, [string]$path) {
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $synth.SelectVoice($voice)
    $synth.Rate = 0
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToWaveFile($path, $fmt)
    $synth.Speak($text)
    $synth.SetOutputToNull()
    $synth.Dispose()
}

# single-speaker.wav: one voice, four classic pangrams (distinctive,
# low-chance-of-coincidence substrings used as expected-words below).
$singleText = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquid jugs. How vexingly quick daft zebras jump. The five boxing wizards jump quickly."
Speak-ToWav $voiceA $singleText (Join-Path $dir "single-speaker.wav")
Write-Host "wrote $(Join-Path $dir 'single-speaker.wav')"

# two-speaker.wav: two distinct voices, 1s silence gap between them.
$aPath = Join-Path $dir "_a.wav"
$bPath = Join-Path $dir "_b.wav"
Speak-ToWav $voiceA "The quick brown fox jumps over the lazy dog." $aPath
Speak-ToWav $voiceB "Pack my box with five dozen liquid jugs." $bPath

Add-Type @"
using System;
using System.IO;

public static class WavConcat
{
    public static void Run(string outPath, string[] inputs, int silenceMs)
    {
        const int sampleRate = 16000;
        const int bytesPerSample = 2;
        int silenceBytes = (silenceMs * sampleRate / 1000) * bytesPerSample;

        using (var outStream = new FileStream(outPath, FileMode.Create))
        using (var writer = new BinaryWriter(outStream))
        {
            writer.Write(new byte[44]);

            long dataBytes = 0;
            for (int i = 0; i < inputs.Length; i++)
            {
                byte[] all = File.ReadAllBytes(inputs[i]);
                byte[] data = new byte[all.Length - 44];
                Array.Copy(all, 44, data, 0, data.Length);
                writer.Write(data);
                dataBytes += data.Length;

                if (i < inputs.Length - 1)
                {
                    writer.Write(new byte[silenceBytes]);
                    dataBytes += silenceBytes;
                }
            }

            outStream.Seek(0, SeekOrigin.Begin);
            writer.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
            writer.Write((int)(36 + dataBytes));
            writer.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));
            writer.Write(System.Text.Encoding.ASCII.GetBytes("fmt "));
            writer.Write(16);
            writer.Write((short)1);
            writer.Write((short)1);
            writer.Write(sampleRate);
            writer.Write(sampleRate * bytesPerSample);
            writer.Write((short)bytesPerSample);
            writer.Write((short)16);
            writer.Write(System.Text.Encoding.ASCII.GetBytes("data"));
            writer.Write((int)dataBytes);
        }
    }
}
"@

$outPath = Join-Path $dir "two-speaker.wav"
[WavConcat]::Run($outPath, @($aPath, $bPath), 1000)
Remove-Item $aPath, $bPath
Write-Host "wrote $outPath"
