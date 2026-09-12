// P0 spike 方案 D：Rust ratatui + crossterm（与 grok-build 同栈）。
// 两种模式：
//   tui-spike-d                → 真机 demo（alt-screen + SGR 滚轮 + 键盘滚动 + 底部输入行回显）
//   tui-spike-d --bench        → headless 压测（TestBackend，同一份 10k 行数据，输出 avg/p95 帧耗）
use std::fs;
use std::io;
use std::time::Instant;

use ratatui::{
    backend::TestBackend,
    crossterm::event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind, MouseEventKind,
    },
    layout::{Constraint, Layout},
    style::{Color, Style},
    text::Line,
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame, Terminal,
};

const TERMINAL_W: u16 = 120;
const TERMINAL_H: u16 = 40;

fn load_lines() -> Vec<String> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../common/transcript-10k.txt");
    let raw = fs::read_to_string(path).expect("read transcript-10k.txt");
    raw.lines().map(|s| s.to_string()).collect()
}

struct ScrollState {
    offset: usize, // 顶部可视行号
    follow: bool,  // 跟随模式：窗口贴底
}

fn visible_window(lines: &[String], state: &ScrollState, height: usize) -> (usize, usize) {
    if state.follow {
        let start = lines.len().saturating_sub(height);
        (start, lines.len())
    } else {
        let start = state.offset.min(lines.len().saturating_sub(1));
        let end = (start + height).min(lines.len());
        (start, end)
    }
}

fn render_frame(f: &mut Frame, lines: &[String], state: &ScrollState, input: &str) {
    let [scroll_area, input_area] =
        Layout::vertical([Constraint::Min(3), Constraint::Length(3)]).areas(f.area());

    let inner_h = scroll_area.height.saturating_sub(2) as usize;
    let (start, end) = visible_window(lines, state, inner_h.max(1));
    let items: Vec<Line> = lines[start..end]
        .iter()
        .map(|l| Line::from(l.clone()))
        .collect();
    let title = format!(
        " scrollback {}..{}/{} {} ",
        start,
        end,
        lines.len(),
        if state.follow { "[follow]" } else { "[anchor]" }
    );
    let para = Paragraph::new(items)
        .block(Block::default().borders(Borders::ALL).title(title))
        .wrap(Wrap { trim: false })
        .style(Style::default().fg(Color::Gray));
    f.render_widget(para, scroll_area);

    let input = Paragraph::new(format!("> {input}_"))
        .block(Block::default().borders(Borders::ALL).title(" input (q quit) "));
    f.render_widget(input, input_area);
}

fn scroll(state: &mut ScrollState, lines: &[String], n: usize) {
    if state.follow {
        return; // 已在底部
    }
    state.offset = (state.offset + n).min(lines.len().saturating_sub(1));
}

fn scroll_back(state: &mut ScrollState, lines: &[String], n: usize, inner_h: usize) {
    if state.follow {
        let start = lines.len().saturating_sub(inner_h);
        state.follow = false;
        state.offset = start.saturating_sub(n);
        return;
    }
    state.offset = state.offset.saturating_sub(n);
}

fn run_demo(lines: Vec<String>) -> io::Result<()> {
    let mut stdout = io::stdout();
    ratatui::crossterm::terminal::enable_raw_mode()?;
    ratatui::crossterm::execute!(
        stdout,
        ratatui::crossterm::terminal::EnterAlternateScreen,
        EnableMouseCapture
    )?;
    let backend = ratatui::backend::CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;

    let mut state = ScrollState {
        offset: 0,
        follow: true,
    };
    let mut input = String::new();
    let inner_h = 35usize; // demo 级近似：120x40 下滚动区可视行数

    let res = (|| -> io::Result<()> {
        loop {
            terminal.draw(|f| render_frame(f, &lines, &state, &input))?;
            match event::read()? {
                Event::Key(k) if k.kind == KeyEventKind::Press => match k.code {
                    KeyCode::Char('q') => break,
                    KeyCode::Char(c) => input.push(c),
                    KeyCode::Backspace => {
                        input.pop();
                    }
                    KeyCode::PageUp => scroll_back(&mut state, &lines, 20, inner_h),
                    KeyCode::PageDown => scroll(&mut state, &lines, 20),
                    KeyCode::Down | KeyCode::Char('j') => scroll(&mut state, &lines, 1),
                    KeyCode::Up | KeyCode::Char('k') => {
                        scroll_back(&mut state, &lines, 1, inner_h)
                    }
                    _ => {}
                },
                Event::Mouse(m) => match m.kind {
                    MouseEventKind::ScrollUp => scroll_back(&mut state, &lines, 3, inner_h),
                    MouseEventKind::ScrollDown => scroll(&mut state, &lines, 3),
                    _ => {}
                },
                Event::Resize(_, _) => {}
                _ => {}
            }
        }
        Ok(())
    })();

    ratatui::crossterm::execute!(
        terminal.backend_mut(),
        DisableMouseCapture,
        ratatui::crossterm::terminal::LeaveAlternateScreen
    )?;
    ratatui::crossterm::terminal::disable_raw_mode()?;
    res
}

fn run_bench(lines: Vec<String>) {
    let mut terminal = Terminal::new(TestBackend::new(TERMINAL_W, TERMINAL_H)).unwrap();
    let inner_h = (TERMINAL_H - 3 - 2) as usize;

    // 1) 初始渲染
    let state0 = ScrollState {
        offset: 0,
        follow: false,
    };
    let t0 = Instant::now();
    terminal
        .draw(|f| render_frame(f, &lines, &state0, ""))
        .unwrap();
    let initial = t0.elapsed();

    // 2) 滚动帧耗：2000 次「滚动一页 + 全帧 diff 绘制」
    let frames = 2000usize;
    let mut samples = Vec::with_capacity(frames);
    for i in 0..frames {
        let step = 20usize;
        let off = ((i + 1) * step) % (lines.len() - inner_h - 1);
        let st = ScrollState {
            offset: off,
            follow: false,
        };
        let t = Instant::now();
        terminal.draw(|f| render_frame(f, &lines, &st, "")).unwrap();
        samples.push(t.elapsed());
    }

    // 3) 静止空转帧（diff 全等，验证差量刷新路径）
    let mut idle = Vec::with_capacity(500);
    for _ in 0..500 {
        let t = Instant::now();
        terminal.draw(|f| render_frame(f, &lines, &state0, "")).unwrap();
        idle.push(t.elapsed());
    }

    let mut scroll_sorted = samples.clone();
    scroll_sorted.sort();
    let p = |q: f64, v: &[std::time::Duration]| -> f64 {
        let idx = ((v.len() as f64 - 1.0) * q).round() as usize;
        v[idx].as_secs_f64() * 1000.0
    };
    let avg = |v: &[std::time::Duration]| -> f64 {
        v.iter().map(|d| d.as_secs_f64()).sum::<f64>() / v.len() as f64 * 1000.0
    };

    println!(
        "mode=ratatui-bench lines={} terminal={w}x{h}",
        lines.len(),
        w = TERMINAL_W,
        h = TERMINAL_H
    );
    println!("initial_render_ms={:.3}", initial.as_secs_f64() * 1000.0);
    println!(
        "scroll_frames={} avg_ms={:.3} p50_ms={:.3} p95_ms={:.3} p99_ms={:.3}",
        frames,
        avg(&samples),
        p(0.50, &scroll_sorted),
        p(0.95, &scroll_sorted),
        p(0.99, &scroll_sorted)
    );
    println!(
        "idle_diff_frames=500 avg_ms={:.3} p95_ms={:.3}",
        avg(&idle),
        p(0.95, &idle)
    );
}

fn main() {
    let lines = load_lines();
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--bench") {
        run_bench(lines);
    } else if let Err(e) = run_demo(lines) {
        eprintln!("demo error: {e}");
        std::process::exit(1);
    }
}
