package main

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jfreymuth/pulse"
)

type AudioEngine struct {
	mu           sync.Mutex
	pulseClient  *pulse.Client
	pulseStream  *pulse.PlaybackStream
	ffmpegCmd    *exec.Cmd
	ytdlpCmd     *exec.Cmd
	ffmpegStdout io.ReadCloser
	volume       float32
	isPlaying    bool
	isPaused     bool
	currentMs    int64
	durationMs   int64
	currentUrl   string
	sampleRate   int
	channels     int
	stopChan     chan struct{}
	bands        [16]float32
}

func NewAudioEngine() (*AudioEngine, error) {
	client, err := pulse.NewClient()
	if err != nil {
		return nil, fmt.Errorf("pulse.NewClient: %w", err)
	}

	return &AudioEngine{
		pulseClient: client,
		volume:      1.0,
		sampleRate:  44100,
		channels:    2,
	}, nil
}

func findBin(name string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	home, _ := os.UserHomeDir()
	localBin := filepath.Join(home, ".local", "bin", name)
	if _, err := os.Stat(localBin); err == nil {
		return localBin
	}
	return name
}

func (e *AudioEngine) Play(target string, startMs int64) error {
	e.stopPlaybackInternal()

	ffmpegBin := findBin("ffmpeg")
	ytDlpBin := findBin("yt-dlp")

	var cmd *exec.Cmd
	var ytdlp *exec.Cmd

	isYtUrl := strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") || (!strings.Contains(target, "/") && len(target) == 11)

	if isYtUrl {
		ytUrl := target
		if !strings.HasPrefix(target, "http") {
			ytUrl = "https://music.youtube.com/watch?v=" + target
		}

		home, _ := os.UserHomeDir()
		cookiesFile := filepath.Join(home, ".config", "lyrical", "cookies.txt")

		ytDlpArgs := []string{
			"-f", "bestaudio/best",
			"--no-playlist",
			"--no-warnings",
			"-q",
		}
		if _, err := os.Stat(cookiesFile); err == nil {
			ytDlpArgs = append(ytDlpArgs, "--cookies", cookiesFile)
		}
		if startMs > 0 {
			startSec := float64(startMs) / 1000.0
			ytDlpArgs = append(ytDlpArgs, "--download-sections", fmt.Sprintf("*%.3f-inf", startSec))
		}
		ytDlpArgs = append(ytDlpArgs, "-o", "-", ytUrl)

		ytdlp = exec.Command(ytDlpBin, ytDlpArgs...)
		ytOut, err := ytdlp.StdoutPipe()
		if err != nil {
			return fmt.Errorf("ytdlp pipe: %w", err)
		}

		ffmpegArgs := []string{
			"-i", "-",
			"-vn",
			"-f", "s16le",
			"-ac", strconv.Itoa(e.channels),
			"-ar", strconv.Itoa(e.sampleRate),
			"-threads", "2",
			"-loglevel", "error",
			"-",
		}

		cmd = exec.Command(ffmpegBin, ffmpegArgs...)
		cmd.Stdin = ytOut

		if err := ytdlp.Start(); err != nil {
			return fmt.Errorf("ytdlp start: %w", err)
		}
	} else {
		// Local file path
		var ffmpegArgs []string
		if startMs > 0 {
			startSec := float64(startMs) / 1000.0
			ffmpegArgs = append(ffmpegArgs, "-ss", fmt.Sprintf("%.3f", startSec))
		}
		ffmpegArgs = append(ffmpegArgs,
			"-i", target,
			"-vn",
			"-f", "s16le",
			"-ac", strconv.Itoa(e.channels),
			"-ar", strconv.Itoa(e.sampleRate),
			"-threads", "2",
			"-loglevel", "error",
			"-",
		)
		cmd = exec.Command(ffmpegBin, ffmpegArgs...)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		if ytdlp != nil && ytdlp.Process != nil {
			_ = ytdlp.Process.Kill()
		}
		return fmt.Errorf("ffmpeg stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		if ytdlp != nil && ytdlp.Process != nil {
			_ = ytdlp.Process.Kill()
		}
		return fmt.Errorf("ffmpeg start: %w", err)
	}

	stopChan := make(chan struct{})

	e.mu.Lock()
	e.ffmpegCmd = cmd
	e.ytdlpCmd = ytdlp
	e.ffmpegStdout = stdout
	e.currentUrl = target
	e.currentMs = startMs
	e.isPlaying = true
	e.isPaused = false
	e.stopChan = stopChan
	e.mu.Unlock()

	// Start playback stream in PulseAudio
	pulseStream, streamErr := e.pulseClient.NewPlayback(
		pulse.Float32Reader(e.readSamples),
		pulse.PlaybackSampleRate(e.sampleRate),
		pulse.PlaybackStereo,
		pulse.PlaybackLatency(0.04),
	)
	if streamErr != nil {
		e.stopPlaybackInternal()
		return fmt.Errorf("pulse NewPlayback: %w", streamErr)
	}

	e.mu.Lock()
	e.pulseStream = pulseStream
	e.mu.Unlock()

	pulseStream.Start()

	go e.monitorPlayback(cmd, ytdlp, stopChan)

	fmt.Println("PLAYING")
	return nil
}

func fftRadix2(real, imag []float64) {
	n := len(real)
	if n <= 1 {
		return
	}

	j := 0
	for i := 0; i < n-1; i++ {
		if i < j {
			real[i], real[j] = real[j], real[i]
			imag[i], imag[j] = imag[j], imag[i]
		}
		k := n / 2
		for k <= j {
			j -= k
			k /= 2
		}
		j += k
	}

	for l := 2; l <= n; l <<= 1 {
		halfLen := l / 2
		angle := -2 * math.Pi / float64(l)
		wStepRe := math.Cos(angle)
		wStepIm := math.Sin(angle)

		for i := 0; i < n; i += l {
			wRe := 1.0
			wIm := 0.0
			for k := 0; k < halfLen; k++ {
				pos := i + k
				posHalf := pos + halfLen
				tRe := wRe*real[posHalf] - wIm*imag[posHalf]
				tIm := wRe*imag[posHalf] + wIm*real[posHalf]
				real[posHalf] = real[pos] - tRe
				imag[posHalf] = imag[pos] - tIm
				real[pos] += tRe
				imag[pos] += tIm

				nextWRe := wRe*wStepRe - wIm*wStepIm
				wIm = wRe*wStepIm + wIm*wStepRe
				wRe = nextWRe
			}
		}
	}
}

func (e *AudioEngine) computeSpectrum(samples []float32) {
	const N = 512
	if len(samples) < 2 {
		return
	}

	mono := make([]float64, N)
	sampleCount := len(samples) / 2
	if sampleCount > N {
		sampleCount = N
	}
	startOffset := len(samples)/2 - sampleCount
	for i := 0; i < sampleCount; i++ {
		idx := (startOffset + i) * 2
		if idx+1 < len(samples) {
			mono[i] = float64(samples[idx]+samples[idx+1]) * 0.5
		}
	}

	real := make([]float64, N)
	imag := make([]float64, N)
	for i := 0; i < N; i++ {
		w := 0.5 * (1.0 - math.Cos(2.0*math.Pi*float64(i)/float64(N-1)))
		real[i] = mono[i] * w
		imag[i] = 0
	}

	fftRadix2(real, imag)

	mags := make([]float64, N/2)
	for i := 0; i < N/2; i++ {
		mags[i] = math.Sqrt(real[i]*real[i]+imag[i]*imag[i]) / float64(N/4)
	}

	bandLimits := [17]int{0, 1, 2, 4, 6, 9, 14, 20, 29, 42, 59, 82, 111, 146, 181, 210, 240}
	eqBoost := [16]float64{2.2, 2.0, 1.8, 1.6, 1.5, 1.5, 1.6, 1.8, 2.0, 2.3, 2.7, 3.2, 3.8, 4.5, 5.2, 6.0}

	for b := 0; b < 16; b++ {
		start := bandLimits[b]
		end := bandLimits[b+1]
		if start >= N/2 {
			break
		}
		if end > N/2 {
			end = N / 2
		}

		var maxVal float64 = 0
		var sumVal float64 = 0
		count := 0
		for k := start; k < end; k++ {
			v := mags[k]
			if v > maxVal {
				maxVal = v
			}
			sumVal += v
			count++
		}

		avgVal := maxVal*0.6 + (sumVal/float64(math.Max(1, float64(count))))*0.4
		scaled := math.Sqrt(avgVal * eqBoost[b]) * 1.5
		if scaled > 1.0 {
			scaled = 1.0
		} else if scaled < 0.0 {
			scaled = 0.0
		}

		current := float64(e.bands[b])
		if scaled > current {
			e.bands[b] = float32(current*0.25 + scaled*0.75)
		} else {
			e.bands[b] = float32(current*0.78 + scaled*0.22)
		}
	}
}

func (e *AudioEngine) readSamples(out []float32) (int, error) {
	e.mu.Lock()
	if !e.isPlaying || e.isPaused || e.ffmpegStdout == nil {
		e.mu.Unlock()
		for i := range out {
			out[i] = 0
		}
		return len(out), nil
	}

	vol := e.volume
	stdout := e.ffmpegStdout
	e.mu.Unlock()

	bytesToRead := len(out) * 2
	buf := make([]byte, bytesToRead)
	n, err := io.ReadFull(stdout, buf)
	if err != nil && n == 0 {
		return 0, err
	}

	samplesRead := n / 2
	rawFloats := make([]float32, samplesRead)

	for i := range samplesRead {
		raw := int16(binary.LittleEndian.Uint16(buf[i*2 : i*2+2]))
		val := float32(raw) / 32768.0 * vol
		out[i] = val
		rawFloats[i] = val
	}

	for i := samplesRead; i < len(out); i++ {
		out[i] = 0
	}

	e.mu.Lock()
	e.computeSpectrum(rawFloats)
	framesRead := samplesRead / e.channels
	addedMs := int64(float64(framesRead) / float64(e.sampleRate) * 1000.0)
	e.currentMs += addedMs
	e.mu.Unlock()

	return len(out), nil
}

func (e *AudioEngine) Pause() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.isPlaying && !e.isPaused {
		e.isPaused = true
		if e.pulseStream != nil {
			e.pulseStream.Pause()
		}
		fmt.Println("PAUSED")
	}
}

func (e *AudioEngine) Resume() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.isPlaying && e.isPaused {
		e.isPaused = false
		if e.pulseStream != nil {
			e.pulseStream.Start()
		}
		fmt.Println("RESUMED")
	}
}

func (e *AudioEngine) Seek(targetMs int64) error {
	e.mu.Lock()
	url := e.currentUrl
	e.currentMs = targetMs
	e.mu.Unlock()

	if url == "" {
		return nil
	}
	return e.Play(url, targetMs)
}

func (e *AudioEngine) SetVolume(pct int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if pct < 0 {
		pct = 0
	}
	if pct > 150 {
		pct = 150
	}
	e.volume = float32(pct) / 100.0
	fmt.Printf("VOLUME %d\n", pct)
}

func (e *AudioEngine) Stop() {
	e.stopPlaybackInternal()
	fmt.Println("STOPPED")
}

func (e *AudioEngine) stopPlaybackInternal() {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.isPlaying = false
	e.isPaused = false
	if e.stopChan != nil {
		select {
		case <-e.stopChan:
		default:
			close(e.stopChan)
		}
	}
	if e.pulseStream != nil {
		e.pulseStream.Stop()
		e.pulseStream.Close()
		e.pulseStream = nil
	}
	if e.ffmpegStdout != nil {
		e.ffmpegStdout.Close()
		e.ffmpegStdout = nil
	}
	if e.ffmpegCmd != nil && e.ffmpegCmd.Process != nil {
		_ = e.ffmpegCmd.Process.Kill()
		e.ffmpegCmd = nil
	}
	if e.ytdlpCmd != nil && e.ytdlpCmd.Process != nil {
		_ = e.ytdlpCmd.Process.Kill()
		e.ytdlpCmd = nil
	}
}

func (e *AudioEngine) monitorPlayback(ffmpeg *exec.Cmd, ytdlp *exec.Cmd, stopChan chan struct{}) {
	done := make(chan error, 1)
	go func() {
		done <- ffmpeg.Wait()
	}()

	select {
	case <-stopChan:
		return
	case <-done:
		select {
		case <-stopChan:
			return
		default:
		}
		e.mu.Lock()
		if e.isPlaying {
			e.isPlaying = false
			fmt.Println("ENDED")
		}
		e.mu.Unlock()
	}
}

func (e *AudioEngine) Status() {
	e.mu.Lock()
	defer e.mu.Unlock()

	status := "stopped"
	if e.isPlaying {
		if e.isPaused {
			status = "paused"
		} else {
			status = "playing"
		}
	}

	var sb strings.Builder
	for i, b := range e.bands {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString(fmt.Sprintf("%.2f", b))
	}

	fmt.Printf("STATUS %s %d %d %s\n", status, e.currentMs, int(e.volume*100), sb.String())
}

func main() {
	engine, err := NewAudioEngine()
	if err != nil {
		fmt.Printf("ERROR Init: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("READY")

	go func() {
		ticker := time.NewTicker(40 * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			engine.Status()
		}
	}()

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		parts := strings.SplitN(line, " ", 3)
		cmd := strings.ToUpper(parts[0])

		switch cmd {
		case "PLAY":
			if len(parts) < 2 {
				fmt.Println("ERROR Missing URL/ID")
				continue
			}
			url := parts[1]
			var startMs int64 = 0
			if len(parts) >= 3 {
				parsed, _ := strconv.ParseInt(parts[2], 10, 64)
				startMs = parsed
			}
			if err := engine.Play(url, startMs); err != nil {
				fmt.Printf("ERROR Play: %v\n", err)
			}

		case "PAUSE":
			engine.Pause()

		case "RESUME":
			engine.Resume()

		case "SEEK":
			if len(parts) >= 2 {
				targetMs, _ := strconv.ParseInt(parts[1], 10, 64)
				if err := engine.Seek(targetMs); err != nil {
					fmt.Printf("ERROR Seek: %v\n", err)
				}
			}

		case "VOLUME":
			if len(parts) >= 2 {
				vol, _ := strconv.Atoi(parts[1])
				engine.SetVolume(vol)
			}

		case "STOP":
			engine.Stop()

		case "STATUS":
			engine.Status()

		case "QUIT", "EXIT":
			engine.Stop()
			return

		default:
			fmt.Printf("ERROR Unknown command: %s\n", cmd)
		}
	}
}
