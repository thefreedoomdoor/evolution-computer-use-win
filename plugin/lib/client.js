/**
 * DSH 设置页：电脑操作模式 + 操作横幅 / 思考窗 / 审计窗外观 + 字体 + 按应用策略。
 *
 * 注册到 DSH 插件管理的两个插槽：
 *   plugins.row.config    —— 已安装插件列表里这一行右侧的配置控件（key = 包名#entry id）
 *   plugins.bundle.config —— 插件详情页里的配置区（key = 包名）
 *
 * 后端接口见 lib/index.js / lib/routes.js：
 *   GET  /read        POST /set          桌面模式与旧浮窗设置（兼容旧版）
 *   GET  /appearance  POST /appearance   三窗完整外观（契约见 docs/design/appearance.md）
 *   GET/POST/DELETE /fonts               字体列表、上传、删除
 *   GET  /apps                           运行中的窗口（仿 OBS 窗口捕捉）
 *   GET/POST /policies                   按应用的前后台策略
 *
 * 只用 require('react') 的 createElement，不引入构建步骤；样式全部内联，
 * 颜色 / 边框优先取 DSH 主题变量 --dsw-alias-*。
 */
window.__ModuleLoader__.load({
  id: 'evolution-computer-use-win',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require('react');
    const h = react.createElement;

    const API = '/api/dsh-evolution-desktop-mode';

    const MODES = [
      { value: 'off', label: '关闭', tip: '不控制电脑' },
      { value: 'background', label: '后台', tip: '只向目标窗口投递输入，不动用户的鼠标键盘' },
      { value: 'foreground', label: '前台', tip: '真实鼠标键盘，切换时会请求管理员授权' },
    ];

    const BANNER_POSITIONS = [
      { value: 'top-left', label: '左上' },
      { value: 'top-center', label: '顶部居中' },
      { value: 'top-right', label: '右上' },
      { value: 'custom', label: '自定义坐标' },
    ];
    const THOUGHT_POSITIONS = [
      { value: 'top-left', label: '左上' },
      { value: 'top-right', label: '右上' },
      { value: 'bottom-left', label: '左下' },
      { value: 'bottom-right', label: '右下' },
      { value: 'custom', label: '自定义坐标' },
    ];
    const AUDIT_POSITIONS = [
      { value: 'left-of-thought', label: '思考窗左侧' },
      { value: 'top-left', label: '左上' },
      { value: 'top-right', label: '右上' },
      { value: 'bottom-left', label: '左下' },
      { value: 'bottom-right', label: '右下' },
      { value: 'custom', label: '自定义坐标' },
    ];
    const ALIGNS = [
      { value: 'left', label: '左对齐' },
      { value: 'center', label: '居中' },
      { value: 'right', label: '右对齐' },
    ];
    const DEFAULT_FONT_FAMILIES = ['Microsoft YaHei UI', 'Segoe UI'];

    // 选中态背景用 brand-primary；部分主题（当前深色主题）里它是近白色，
    // 因此选中态文字必须用深色，否则会白底白字完全不可见。
    const onBrandText = 'var(--dsw-alias-brand-foreground, #0b0d10)';

    const buttonStyle = {
      fontSize: '11px',
      lineHeight: '18px',
      padding: '0 8px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45))',
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    };

    const rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' };
    const labelStyle = { fontSize: '12px', opacity: 0.8, minWidth: '56px' };
    const miniLabelStyle = { fontSize: '10px', lineHeight: '14px', opacity: 0.65, whiteSpace: 'nowrap' };
    const hintStyle = { fontSize: '11px', lineHeight: '16px', opacity: 0.62 };
    const errorStyle = { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-state-error-primary, #e5484d)' };
    const boxStyle = {
      fontSize: '12px',
      lineHeight: '20px',
      padding: '1px 6px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45))',
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      minWidth: 0,
    };
    const cardStyle = {
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))',
      borderRadius: '8px',
      padding: '10px 12px',
      background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06))',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      minWidth: 0,
    };

    const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

    /** 与服务器 / 后端的深合并语义一致：只覆盖补丁里出现的键。 */
    function mergeDeep(base, patch) {
      const source = isObject(base) ? base : {};
      const result = Object.assign({}, source);
      if (!isObject(patch)) return result;
      Object.keys(patch).forEach((key) => {
        const next = patch[key];
        if (isObject(next)) result[key] = mergeDeep(source[key], next);
        else if (next !== undefined) result[key] = next;
      });
      return result;
    }

    function clampNumber(value, min, max, fallback) {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    }

    function Card(props) {
      return h('div', { style: cardStyle }, props.children);
    }

    function CardTitle(props) {
      return h(
        'div',
        { style: { fontSize: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
        props.children
      );
    }

    function ErrorLine(props) {
      return props.text ? h('div', { role: 'alert', style: errorStyle }, props.text) : null;
    }

    function DesktopModeControl(props) {
      const compact = !props || props.view === 'summary';
      const [mode, setMode] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState('');
      const [showOverlay, setShowOverlay] = react.useState(false);
      const buttons = react.useRef([]);
      const alive = react.useRef(true);

      const load = () => {
        setBusy(true);
        fetch(API + '/read', { cache: 'no-store' })
          .then((response) => response.json())
          .then((data) => {
            if (!alive.current) return;
            if (data && data.ok && data.value) {
              setMode(data.value.desktopMode);
              setError('');
            } else setError((data && data.message) || '读取模式失败');
          })
          .catch(() => {
            if (alive.current) setError('读取模式失败：本机接口没有响应');
          })
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      };

      react.useEffect(() => {
        alive.current = true;
        load();
        return () => {
          alive.current = false;
        };
      }, []);

      const change = (next) => {
        if (busy || next === mode) return;
        setBusy(true);
        setError('');
        fetch(API + '/set', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ desktopMode: next }),
        })
          .then((response) => response.json())
          .then((data) => {
            if (!alive.current) return;
            if (data && data.ok && data.value) setMode(data.value.desktopMode);
            else setError((data && data.message) || '保存失败');
          })
          .catch((err) => {
            if (alive.current) setError(String(err && err.message ? err.message : err));
          })
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      };

      const group = h(
        'div',
        {
          role: 'radiogroup',
          'aria-label': '电脑操作模式',
          style: {
            display: 'inline-flex',
            alignItems: 'stretch',
            border: '1px solid rgba(128,128,128,.45)',
            borderRadius: '7px',
            overflow: 'hidden',
            verticalAlign: 'middle',
          },
        },
        MODES.map((item, index) =>
          h(
            'button',
            {
              key: item.value,
              type: 'button',
              role: 'radio',
              'aria-checked': mode === item.value ? 'true' : 'false',
              title: item.tip,
              tabIndex: mode === null || mode === item.value ? 0 : -1,
              disabled: busy || mode === null,
              ref: (el) => {
                buttons.current[index] = el;
              },
              onClick: (event) => {
                event.stopPropagation();
                change(item.value);
              },
              onKeyDown: (event) => {
                const delta =
                  event.key === 'ArrowRight' || event.key === 'ArrowDown'
                    ? 1
                    : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                      ? -1
                      : 0;
                if (!delta) return;
                event.preventDefault();
                const target = (index + delta + MODES.length) % MODES.length;
                change(MODES[target].value);
                const el = buttons.current[target];
                if (el) el.focus();
              },
              style: {
                fontSize: compact ? '12px' : '13px',
                lineHeight: compact ? '20px' : '24px',
                padding: compact ? '1px 9px' : '2px 14px',
                border: 'none',
                borderLeft: index === 0 ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))',
                background: mode === item.value ? 'var(--dsw-alias-brand-primary, rgba(59,130,246,.88))' : 'transparent',
                color: mode === item.value ? onBrandText : 'inherit',
                fontWeight: mode === item.value ? 600 : 400,
                cursor: busy ? 'progress' : 'pointer',
                whiteSpace: 'nowrap',
              },
            },
            item.label
          )
        )
      );

      const status = h(
        'span',
        {
          role: 'status',
          'aria-live': 'polite',
          style: {
            fontSize: '11px',
            opacity: error ? 1 : 0.75,
            fontWeight: error ? 600 : 400,
            color: error ? 'var(--dsw-alias-state-error-primary, inherit)' : undefined,
          },
        },
        busy ? '保存中…' : error ? error : mode === null ? '加载中…' : ''
      );

      const retry = error ? h('button', { type: 'button', style: buttonStyle, disabled: busy, onClick: load }, '重试') : null;

      const modeSection = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '13px', fontWeight: 600 } }, '电脑操作模式'),
          group,
          status,
          retry
        ),
        h(
          'div',
          { style: { fontSize: '11px', opacity: 0.75, lineHeight: '16px' } },
          '关闭＝不控制电脑；后台＝只向目标窗口投递输入，不动用户的鼠标键盘；前台＝真实鼠标键盘，切换时请求管理员授权。选择后立即生效：正在运行的 evolution-computer-use MCP 服务器每 0.8 秒读取一次该设置。'
        ),
        h(
          'div',
          { style: { fontSize: '11px', opacity: 0.55, lineHeight: '16px' } },
          '「按应用」里的策略会覆盖这里的全局模式；没有策略的程序仍用这里的选择。'
        )
      );

      if (compact) {
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px' }, onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: '12px', opacity: 0.75 } }, '电脑操作模式'),
            group,
            status,
            retry,
            h(
              'button',
              {
                type: 'button',
                style: buttonStyle,
                'aria-expanded': showOverlay ? 'true' : 'false',
                onClick: (event) => {
                  event.stopPropagation();
                  setShowOverlay(!showOverlay);
                },
              },
              showOverlay ? '收起外观设置' : '外观设置'
            )
          ),
          showOverlay ? h(AppearanceSettings, { modeSection: modeSection, initialTab: 'banner' }) : null
        );
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '4px 0' }, onClick: (event) => event.stopPropagation() },
        h(AppearanceSettings, { modeSection: modeSection, initialTab: 'mode' })
      );
    }


    // --- 颜色：HSV 调色板 ---------------------------------------------------

    const PRESET_COLORS = [
      '#0B0D12', '#111827', '#191D26', '#1F2430', '#252B38', '#2A3140',
      '#312E81', '#1E1B4B', '#0C4A6E', '#14532D', '#7F1D1D', '#7C2D12',
      '#F5F7FA', '#E6EAF2', '#B9C6D8', '#8A93A3', '#5B8DEF', '#408CFF',
      '#4ADE80', '#22C55E', '#C7B26B', '#F59E0B', '#EC4899', '#A855F7',
    ];

    function toHex2(value) {
      const n = Math.max(0, Math.min(255, Math.round(value)));
      return (n < 16 ? '0' : '') + n.toString(16).toUpperCase();
    }

    /** #RRGGBB / #AARRGGBB -> {a,r,g,b}；alpha 在前（appearance 契约）。 */
    function parseColor(value) {
      const body = String(value == null ? '' : value).trim().replace(/^#/, '').toUpperCase();
      if (/^[0-9A-F]{6}$/.test(body)) {
        return { a: 255, r: parseInt(body.slice(0, 2), 16), g: parseInt(body.slice(2, 4), 16), b: parseInt(body.slice(4, 6), 16) };
      }
      if (/^[0-9A-F]{8}$/.test(body)) {
        return {
          a: parseInt(body.slice(0, 2), 16),
          r: parseInt(body.slice(2, 4), 16),
          g: parseInt(body.slice(4, 6), 16),
          b: parseInt(body.slice(6, 8), 16),
        };
      }
      return null;
    }

    function formatColor(color, allowAlpha) {
      const body = toHex2(color.r) + toHex2(color.g) + toHex2(color.b);
      return allowAlpha ? '#' + toHex2(color.a) + body : '#' + body;
    }

    function rgbToHsv(r, g, b) {
      const rn = r / 255;
      const gn = g / 255;
      const bn = b / 255;
      const max = Math.max(rn, gn, bn);
      const min = Math.min(rn, gn, bn);
      const d = max - min;
      let hue = 0;
      if (d > 0) {
        if (max === rn) hue = ((gn - bn) / d) % 6;
        else if (max === gn) hue = (bn - rn) / d + 2;
        else hue = (rn - gn) / d + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
      }
      return { h: hue, s: max === 0 ? 0 : d / max, v: max };
    }

    function hsvToRgb(hue, s, v) {
      const hh = ((hue % 360) + 360) % 360;
      const ss = Math.max(0, Math.min(1, s));
      const vv = Math.max(0, Math.min(1, v));
      const c = vv * ss;
      const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
      const m = vv - c;
      let r = 0;
      let g = 0;
      let b = 0;
      if (hh < 60) { r = c; g = x; }
      else if (hh < 120) { r = x; g = c; }
      else if (hh < 180) { g = c; b = x; }
      else if (hh < 240) { g = x; b = c; }
      else if (hh < 300) { r = x; b = c; }
      else { r = c; b = x; }
      return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
    }

    function hueColor(hue) {
      const rgb = hsvToRgb(hue, 1, 1);
      return 'rgb(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ')';
    }

    function hasDarkText(color) {
      if (!color) return false;
      const y = (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
      return y > 0.62;
    }

    /**
     * 一个颜色字段：色块 + hex 输入 + 展开的 HSV 调色板（色相条 + 饱和度/明度画布 + 预设色板）。
     * allowAlpha 用于 #AARRGGBB 形式的背景色，alpha 可以调，也可以直接用透明度滑杆表达。
     */
    function ColorField(props) {
      const allowAlpha = props.allowAlpha === true;
      const value = String(props.value == null ? '' : props.value);
      const parsed = parseColor(value) || { a: 255, r: 0, g: 0, b: 0 };
      const [openField, setOpenField] = react.useState(false);
      const [hsv, setHsv] = react.useState(() => rgbToHsv(parsed.r, parsed.g, parsed.b));
      const [hexText, setHexText] = react.useState(value);
      const dragging = react.useRef(false);

      react.useEffect(() => {
        if (!dragging.current) {
          const next = parseColor(value);
          if (next) setHsv(rgbToHsv(next.r, next.g, next.b));
        }
        setHexText(value);
      }, [value]);

      const emit = (nextHsv) => {
        const rgb = hsvToRgb(nextHsv.h, nextHsv.s, nextHsv.v);
        const current = parseColor(value) || parsed;
        props.onChange(formatColor({ a: current.a, r: rgb.r, g: rgb.g, b: rgb.b }, allowAlpha));
      };

      const pickSv = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
        const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
        const next = { h: hsv.h, s: x, v: 1 - y };
        setHsv(next);
        emit(next);
      };

      const pickHue = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
        const next = { h: y * 359.9, s: hsv.s, v: hsv.v };
        setHsv(next);
        emit(next);
      };

      const begin = (handler) => (event) => {
        event.preventDefault();
        dragging.current = true;
        if (event.currentTarget.setPointerCapture) {
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch (error) { /* 忽略不支持捕获的环境 */ }
        }
        handler(event);
      };
      const move = (handler) => (event) => {
        if (dragging.current) handler(event);
      };
      const end = () => {
        dragging.current = false;
      };

      // hex 只在回车 / 失焦时提交，避免输入 #AARRGGBB 的途中被规范化打断。
      // hex 里写了 8 位（#AARRGGBB）时用用户给的 alpha；只写 6 位时保留当前 alpha。
      const commitHex = (raw) => {
        const next = parseColor(raw);
        if (!next || !props.onChange) return;
        const current = parseColor(value) || parsed;
        const body = String(raw == null ? '' : raw).trim().replace(/^#/, '');
        const alpha = body.length === 8 ? next.a : current.a;
        const canonical = formatColor({ a: alpha, r: next.r, g: next.g, b: next.b }, allowAlpha);
        if (canonical !== value) props.onChange(canonical);
      };

      const setAlpha = (event) => {
        const alpha = Number(event.target.value);
        const current = parseColor(value) || parsed;
        props.onChange(formatColor({ a: alpha, r: current.r, g: current.g, b: current.b }, true));
      };

      const applyPreset = (preset) => {
        const next = parseColor(preset);
        if (!next) return;
        const current = parseColor(value) || parsed;
        props.onChange(formatColor({ a: current.a, r: next.r, g: next.g, b: next.b }, allowAlpha));
      };

      const swatch = h('span', {
        style: {
          width: '26px',
          height: '18px',
          borderRadius: '4px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.5))',
          background: props.value,
          flex: '0 0 auto',
          display: 'inline-block',
        },
      });

      const palette = openField
        ? h(
            'div',
            {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))',
                borderRadius: '8px',
                padding: '8px',
                background: 'var(--dsw-alias-bg-base, rgba(0,0,0,.12))',
              },
            },
            h(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'stretch', flexWrap: 'wrap' } },
              h(
                'div',
                {
                  title: '饱和度 / 明度',
                  style: {
                    position: 'relative',
                    width: '150px',
                    height: '120px',
                    flex: '0 0 auto',
                    borderRadius: '4px',
                    cursor: 'crosshair',
                    touchAction: 'none',
                    backgroundColor: hueColor(hsv.h),
                    backgroundImage:
                      'linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0))',
                  },
                  onPointerDown: begin(pickSv),
                  onPointerMove: move(pickSv),
                  onPointerUp: end,
                  onPointerCancel: end,
                },
                h('span', {
                  style: {
                    position: 'absolute',
                    left: hsv.s * 100 + '%',
                    top: (1 - hsv.v) * 100 + '%',
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    border: '2px solid #fff',
                    boxShadow: '0 0 0 1px rgba(0,0,0,.65)',
                    transform: 'translate(-50%, -50%)',
                    pointerEvents: 'none',
                  },
                })
              ),
              h(
                'div',
                {
                  title: '色相',
                  style: {
                    position: 'relative',
                    width: '16px',
                    height: '120px',
                    flex: '0 0 auto',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    touchAction: 'none',
                    background:
                      'linear-gradient(to bottom, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)',
                  },
                  onPointerDown: begin(pickHue),
                  onPointerMove: move(pickHue),
                  onPointerUp: end,
                  onPointerCancel: end,
                },
                h('span', {
                  style: {
                    position: 'absolute',
                    left: '-3px',
                    right: '-3px',
                    top: (hsv.h / 360) * 100 + '%',
                    height: '4px',
                    borderRadius: '2px',
                    border: '1px solid #fff',
                    boxShadow: '0 0 0 1px rgba(0,0,0,.6)',
                    transform: 'translateY(-50%)',
                    pointerEvents: 'none',
                  },
                })
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '6px', flex: '1 1 120px', minWidth: '120px' } },
                h(
                  'div',
                  { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(18px, 1fr))', gap: '4px' } },
                  PRESET_COLORS.map((preset) =>
                    h('button', {
                      key: preset,
                      type: 'button',
                      title: preset,
                      onClick: () => applyPreset(preset),
                      style: {
                        height: '16px',
                        padding: 0,
                        borderRadius: '3px',
                        border: '1px solid rgba(128,128,128,.45)',
                        background: preset,
                        cursor: 'pointer',
                      },
                    })
                  )
                ),
                allowAlpha
                  ? h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                      h('span', { style: miniLabelStyle }, '背景不透明度'),
                      h('input', {
                        type: 'range',
                        min: 0,
                        max: 255,
                        value: parsed.a,
                        onChange: setAlpha,
                        'aria-label': '背景颜色 alpha',
                        style: { flex: '1 1 60px', accentColor: 'var(--dsw-alias-brand-primary, #5b8def)' },
                      }),
                      h('span', { style: { fontSize: '10px', opacity: 0.7, minWidth: '30px', textAlign: 'right' } },
                        Math.round((parsed.a / 255) * 100) + '%'
                      )
                    )
                  : null,
                h('div', { style: hintStyle },
                  allowAlpha ? 'alpha 在 hex 前两位（#AARRGGBB），也可以用上方的滑块。' : '拖动色相条和画布选色。'
                )
              )
            )
          )
        : null;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px', flex: '1 1 220px', minWidth: '190px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            title: '打开调色板',
            'aria-label': props.label + ' 调色板',
            'aria-expanded': openField ? 'true' : 'false',
            onClick: () => setOpenField(!openField),
            style: { border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', display: 'inline-flex' },
          }, swatch),
          h('span', { style: labelStyle }, props.label),
          h('input', {
            type: 'text',
            value: hexText,
            'aria-label': props.label + ' 颜色值',
            onChange: (event) => setHexText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                commitHex(hexText);
                event.currentTarget.blur();
              }
            },
            onBlur: () => {
              commitHex(hexText);
              setHexText(value);
            },
            style: Object.assign({}, boxStyle, { width: '104px', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '11px' }),
          }),
          h('button', {
            type: 'button',
            style: buttonStyle,
            onClick: () => setOpenField(!openField),
          }, openField ? '收起' : '调色')
        ),
        palette
      );
    }


    // --- 通用字段 -----------------------------------------------------------

    function NumberField(props) {
      const [text, setText] = react.useState(() => String(props.value == null ? '' : props.value));
      const focused = react.useRef(false);
      react.useEffect(() => {
        if (!focused.current) setText(String(props.value == null ? '' : props.value));
      }, [props.value]);
      const commit = (raw) => {
        if (raw === '') return;
        const n = Number(raw);
        if (isFinite(n) && props.onChange) props.onChange(n);
      };
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: '3px', flex: props.flex || '0 1 120px', minWidth: '96px' } },
        props.label ? h('span', { style: miniLabelStyle }, props.label) : null,
        h('input', {
          type: 'text',
          inputMode: 'decimal',
          value: text,
          'aria-label': props.label,
          onFocus: () => { focused.current = true; },
          onChange: (event) => {
            const raw = event.target.value;
            setText(raw);
            commit(raw);
          },
          onBlur: () => {
            focused.current = false;
            setText(String(props.value == null ? '' : props.value));
          },
          style: boxStyle,
        })
      );
    }

    function SliderField(props) {
      const value = Number(props.value == null ? props.min : props.value);
      const step = props.step == null ? 1 : props.step;
      const readout = typeof props.format === 'function'
        ? props.format(value)
        : String(Math.round(value * 100) / 100) + (props.suffix || '');
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 190px', minWidth: '180px' } },
        h('span', { style: Object.assign({}, labelStyle, { minWidth: '68px' }) }, props.label),
        h('input', {
          type: 'range',
          min: props.min,
          max: props.max,
          step: step,
          value: value,
          'aria-label': props.label,
          onChange: (event) => {
            if (props.onChange) props.onChange(Number(event.target.value));
          },
          style: { flex: '1 1 80px', minWidth: '80px', accentColor: 'var(--dsw-alias-brand-primary, #5b8def)' },
        }),
        h('span', { style: { fontSize: '10px', opacity: 0.72, minWidth: '48px', textAlign: 'right' } }, readout)
      );
    }

    function TextField(props) {
      const common = {
        value: props.value == null ? '' : props.value,
        'aria-label': props.label,
        placeholder: props.placeholder,
        maxLength: props.maxLength,
        onChange: (event) => {
          if (props.onChange) props.onChange(event.target.value);
        },
        style: Object.assign({}, boxStyle, props.width ? { width: props.width } : null),
      };
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: '3px', flex: props.flex || '1 1 200px', minWidth: '150px' } },
        props.label ? h('span', { style: miniLabelStyle }, props.label) : null,
        props.multiline ? h('textarea', Object.assign({ rows: props.rows || 2, resize: 'vertical' }, common)) : h('input', Object.assign({ type: 'text' }, common))
      );
    }

    function SelectField(props) {
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: '3px', flex: props.flex || '0 1 180px', minWidth: '140px' } },
        props.label ? h('span', { style: miniLabelStyle }, props.label) : null,
        h(
          'select',
          {
            value: props.value == null ? '' : props.value,
            'aria-label': props.label,
            onChange: (event) => {
              if (props.onChange) props.onChange(event.target.value);
            },
            style: boxStyle,
          },
          props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label))
        )
      );
    }

    function CheckField(props) {
      return h(
        'label',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer', flex: '0 0 auto' } },
        h('input', {
          type: 'checkbox',
          checked: props.checked !== false,
          onChange: (event) => {
            if (props.onChange) props.onChange(event.target.checked);
          },
          style: { accentColor: 'var(--dsw-alias-brand-primary, #5b8def)', margin: 0 },
        }),
        h('span', null, props.label)
      );
    }

    function FieldGrid(props) {
      return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end' } }, props.children);
    }

    // --- 字体 ---------------------------------------------------------------

    function fontStack(family) {
      const picked = family || DEFAULT_FONT_FAMILIES[0];
      return '"' + picked + '", "Microsoft YaHei UI", "Segoe UI", sans-serif';
    }

    function FontPicker(props) {
      const font = props.font || {};
      const fonts = props.fonts || { installed: [], uploaded: [] };
      const options = [];
      const seen = {};
      const push = (family, label) => {
        const key = String(family).toLowerCase();
        if (!family || seen[key]) return;
        seen[key] = true;
        options.push({ value: family, label: label });
      };
      DEFAULT_FONT_FAMILIES.forEach((family) => push(family, family + '（系统默认）'));
      (fonts.installed || []).forEach((item) => {
        if (item && item.free) push(item.family, item.family + '（免费商用）');
      });
      (fonts.uploaded || []).forEach((item) => push(item.family || item.file, (item.family || item.file) + '（已上传）'));
      push(font.family, font.family + '（当前）');
      return h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end' } },
        h(SelectField, {
          label: props.label || '字体',
          value: font.family || DEFAULT_FONT_FAMILIES[0],
          options: options,
          flex: '1 1 220px',
          onChange: (family) => props.onPatch({ family: family }),
        }),
        h(NumberField, {
          label: '字号',
          value: font.size,
          flex: '0 1 84px',
          onChange: (size) => props.onPatch({ size: size }),
        }),
        h(CheckField, {
          label: '粗体',
          checked: font.bold !== false,
          onChange: (bold) => props.onPatch({ bold: bold }),
        })
      );
    }

    function FontsPanel(props) {
      const fonts = props.fonts || { installed: [], uploaded: [] };
      const [status, setStatus] = react.useState('');
      const [notice, setNotice] = react.useState('');
      const [uploading, setUploading] = react.useState(false);
      const inputRef = react.useRef(null);
      const freeFamilies = (fonts.installed || []).filter((item) => item && item.free).map((item) => item.family);
      const uploaded = fonts.uploaded || [];

      const pickFile = () => {
        if (inputRef.current) inputRef.current.click();
      };

      const onFile = (event) => {
        const file = event.target && event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        const name = String(file.name || '');
        if (!/\.(ttf|otf)$/i.test(name)) {
          setStatus('只支持 .ttf / .otf 字体文件');
          return;
        }
        if (file.size > 8 * 1024 * 1024) {
          setStatus('字体文件不能超过 8MB');
          return;
        }
        setUploading(true);
        setStatus('正在上传 ' + name + '…');
        const reader = new FileReader();
        reader.onerror = () => {
          setUploading(false);
          setStatus('读取字体文件失败');
        };
        reader.onload = () => {
          const text = String(reader.result || '');
          const comma = text.indexOf(',');
          const base64 = comma >= 0 ? text.slice(comma + 1) : text;
          Promise.resolve(props.onUpload({ name: name, dataBase64: base64 }))
            .then((result) => {
              if (result && result.ok === false) {
                setStatus(result.message || '上传失败');
                return;
              }
              const family = result && result.value ? result.value.family : '';
              setStatus(family ? '已上传：' + family : '已上传');
              setNotice('新字体已复制到 fonts 目录，刷新字体列表即可选择。');
              if (props.onRefresh) props.onRefresh(true);
            })
            .catch((error) => setStatus('上传失败：' + String(error && error.message ? error.message : error)))
            .then(() => setUploading(false));
        };
        reader.readAsDataURL(file);
      };

      const remove = (file) => {
        if (!file) return;
        setStatus('正在删除 ' + file + '…');
        Promise.resolve(props.onDelete(file))
          .then((result) => {
            if (result && result.ok === false) {
              setStatus(result.message || '删除失败');
              return;
            }
            setStatus('已删除 ' + file);
            if (props.onRefresh) props.onRefresh(true);
          })
          .catch((error) => setStatus('删除失败：' + String(error && error.message ? error.message : error)));
      };

      return h(
        Card,
        null,
        h(CardTitle, null, '字体'),
        h('div', { style: hintStyle },
          '上传的 .ttf / .otf 会复制到 ~/.evolution-computer-use/fonts/，浮窗用 PrivateFontCollection 加载。',
          '字体族未安装时会退回 Microsoft YaHei UI → Segoe UI。'
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('button', { type: 'button', style: buttonStyle, onClick: pickFile, disabled: uploading }, uploading ? '上传中…' : '上传字体'),
          h('button', { type: 'button', style: buttonStyle, onClick: () => props.onRefresh && props.onRefresh(true) }, '刷新字体列表'),
          h('span', { style: { fontSize: '11px', opacity: 0.78 } },
            '免费商用（已安装 ' + freeFamilies.length + ' 个）：' + (freeFamilies.length ? freeFamilies.join('、') : '未检测到')
          ),
          h('input', {
            ref: inputRef,
            type: 'file',
            accept: '.ttf,.otf',
            style: { display: 'none' },
            onChange: onFile,
          })
        ),
        status
          ? h('div', {
              role: 'status',
              style: Object.assign({}, hintStyle, /失败|不能|只支持|错误/.test(status) ? { color: 'var(--dsw-alias-state-error-primary, #ff6b6b)' } : null),
            }, status)
          : null,
        notice ? h('div', { style: hintStyle }, notice) : null,
        uploaded.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              uploaded.map((item) =>
                h(
                  'div',
                  { key: item.file, style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' } },
                  h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    (item.family || item.file) + ' · ' + item.file
                  ),
                  h('button', { type: 'button', style: buttonStyle, onClick: () => remove(item.file) }, '删除')
                )
              )
            )
          : h('div', { style: hintStyle }, '还没有上传的字体。')
      );
    }

    // --- 预览 ---------------------------------------------------------------

    function previewFrame(text) {
      return h('div', { style: { fontSize: '10px', opacity: 0.6, letterSpacing: '0.4px', textTransform: 'uppercase' } }, text);
    }

    function BannerPreview(props) {
      const banner = props.banner || {};
      const colors = banner.colors || {};
      const fonts = banner.fonts || {};
      const layout = banner.layout || {};
      const main = fonts.main || {};
      const hint = fonts.hint || {};
      const stop = fonts.stop || {};
      const height = Number(banner.height) || 38;
      const pad = Number(layout.padding) || 16;
      const gap = Number(layout.gap) || 10;
      const offsetX = Number(layout.offsetX) || 0;
      const offsetY = Number(layout.offsetY) || 0;
      const text = String(banner.text || '').replace('{app}', '微信');
      const justify = layout.align === 'left' ? 'flex-start' : layout.align === 'right' ? 'flex-end' : 'center';
      return h(
        'div',
        { style: { display: 'flex', justifyContent: justify, padding: '6px 0' } },
        h(
          'div',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: gap + 'px',
              height: height + 'px',
              boxSizing: 'border-box',
              padding: '0 ' + pad + 'px',
              borderRadius: Math.min(height / 2, 24) + 'px',
              background: colors.bg || '#EC181A20',
              border: '1px solid ' + (colors.border || 'transparent'),
              color: colors.text || '#F5F7FA',
              opacity: (Number(banner.opacity) || 100) / 100,
              transform: 'translate(' + offsetX * 0.4 + 'px, ' + offsetY * 0.4 + 'px)',
              maxWidth: '100%',
              overflow: 'hidden',
            },
          },
          h('span', {
            style: {
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: colors.dot || '#408CFF',
              flex: '0 0 auto',
            },
          }),
          h('span', {
            style: {
              fontSize: Math.min(Number(main.size) || 14, 18) + 'px',
              fontFamily: fontStack(main.family),
              fontWeight: main.bold !== false ? 600 : 400,
              whiteSpace: 'nowrap',
            },
          }, text),
          h('span', {
            style: {
              fontSize: Math.min(Number(hint.size) || 12.5, 16) + 'px',
              fontFamily: fontStack(hint.family),
              fontWeight: hint.bold ? 600 : 400,
              color: colors.hint || '#969CA8',
              whiteSpace: 'nowrap',
            },
          }, banner.hint || ''),
          h('span', {
            style: {
              fontSize: Math.min(Number(stop.size) || 12.5, 16) + 'px',
              fontFamily: fontStack(stop.family),
              fontWeight: stop.bold ? 600 : 400,
              color: colors.stopText || '#F0F2F6',
              background: colors.stopBg || '#22FFFFFF',
              borderRadius: '999px',
              padding: '3px 10px',
              whiteSpace: 'nowrap',
            },
          }, banner.stop || '停下')
        )
      );
    }

    function ThoughtPreview(props) {
      const thought = props.thought || {};
      const colors = thought.colors || {};
      const fonts = thought.fonts || {};
      const title = fonts.title || {};
      const body = fonts.body || {};
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        previewFrame('思考窗预览'),
        h(
          'div',
          {
            style: {
              width: Math.min(Number(thought.width) || 360, 420) + 'px',
              height: Math.min(Number(thought.height) || 240, 260) + 'px',
              maxWidth: '100%',
              boxSizing: 'border-box',
              borderRadius: '10px',
              border: '1px solid ' + (colors.border || '#75A1DA'),
              background: colors.bg || '#99191D26',
              opacity: (Number(thought.opacity) || 60) / 100,
              padding: '10px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              overflow: 'hidden',
            },
          },
          h('div', {
            style: {
              fontSize: (Number(title.size) || 14) + 'px',
              fontFamily: fontStack(title.family),
              fontWeight: title.bold !== false ? 600 : 400,
              color: colors.text || '#F6F7FA',
              borderBottom: '1px solid ' + (colors.border || '#75A1DA'),
              paddingBottom: '6px',
            },
          }, '思考中…'),
          h('div', {
            style: {
              fontSize: (Number(body.size) || 14) + 'px',
              fontFamily: fontStack(body.family),
              fontWeight: body.bold ? 600 : 400,
              color: colors.text || '#F6F7FA',
              lineHeight: 1.5,
            },
          }, '先枚举当前可见的顶层窗口，再按标题匹配到目标窗口。'),
          h('div', {
            style: {
              fontSize: Math.max(10, (Number(body.size) || 14) * 0.82) + 'px',
              fontFamily: fontStack(body.family),
              color: colors.muted || '#B9C6D8',
            },
          }, '正在读取窗口列表…'),
          h('div', { style: { marginTop: 'auto', height: '3px', borderRadius: '2px', background: colors.accent || '#5B8DEF', width: '62%' } })
        )
      );
    }

    function AuditPreview(props) {
      const audit = props.audit || {};
      const colors = audit.colors || {};
      const fonts = audit.fonts || {};
      const layout = audit.layout || {};
      const title = fonts.title || {};
      const body = fonts.body || {};
      const rows = Math.max(3, Math.min(Number(layout.rows) || 12, 40));
      const sample = [];
      for (let i = 0; i < Math.min(rows, 6); i += 1) {
        sample.push({
          time: '14:0' + i + ':12',
          tool: i % 2 === 0 ? 'desktop' : 'page_open',
          reason: i === 0 ? 'exe:explorer.exe 命中策略' : '',
        });
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        previewFrame('审计窗预览'),
        h(
          'div',
          {
            style: {
              width: Math.min(Number(audit.width) || 420, 440) + 'px',
              height: Math.min(Number(audit.height) || 340, 300) + 'px',
              maxWidth: '100%',
              boxSizing: 'border-box',
              borderRadius: '10px',
              border: '1px solid ' + (colors.border || '#2A3140'),
              background: colors.bg || '#EB0B0D12',
              opacity: (Number(audit.opacity) || 88) / 100,
              padding: (Number(layout.padding) || 12) + 'px',
              display: 'flex',
              flexDirection: 'column',
              gap: (Number(layout.gap) || 6) + 'px',
              overflow: 'hidden',
            },
          },
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: (Number(title.size) || 13) + 'px',
              fontFamily: fontStack(title.family),
              fontWeight: title.bold !== false ? 600 : 400,
              color: colors.text || '#E6EAF2',
            },
          }, h('span', null, '操作审计'), h('span', { style: { color: colors.accent || '#4ADE80', fontSize: '11px' } }, '直播')),
          sample.map((row, index) =>
            h(
              'div',
              { key: index, style: { display: 'flex', alignItems: 'flex-start', gap: '6px', fontSize: (Number(body.size) || 12.5) + 'px', fontFamily: fontStack(body.family), color: colors.text || '#E6EAF2' } },
              layout.showThumb
                ? h('span', { style: { width: '24px', height: '16px', flex: '0 0 auto', borderRadius: '3px', background: colors.shot || '#5B8DEF', opacity: 0.6 } })
                : null,
              layout.showTime
                ? h('span', { style: { color: colors.muted || '#8A93A3', flex: '0 0 auto' } }, row.time)
                : null,
              h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.tool),
              layout.showReason && row.reason
                ? h('span', { style: { color: colors.reason || '#C7B26B', fontSize: '10px', flex: '0 0 auto' } }, row.reason)
                : null
            )
          )
        )
      );
    }


    // --- 各窗口的编辑器 -----------------------------------------------------

    function SectionNote(props) {
      return h('div', { style: hintStyle }, props.children);
    }

    function BannerEditor(props) {
      const banner = props.banner || {};
      const fonts = banner.fonts || {};
      const colors = banner.colors || {};
      const layout = banner.layout || {};
      const custom = banner.position === 'custom';
      const patchFont = (key, patch) => {
        const next = {};
        next[key] = Object.assign({}, fonts[key], patch);
        props.onPatch({ fonts: next });
      };
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h(
          Card,
          null,
          h(CardTitle, null, '文案'),
          h(
            FieldGrid,
            null,
            h(TextField, {
              label: '正文（{app} 会替换成程序名）',
              value: banner.text,
              maxLength: 120,
              flex: '2 1 320px',
              onChange: (text) => props.onPatch({ text: text }),
            }),
            h(TextField, {
              label: '提示文字',
              value: banner.hint,
              maxLength: 120,
              onChange: (hint) => props.onPatch({ hint: hint }),
            }),
            h(TextField, {
              label: '停止按钮',
              value: banner.stop,
              maxLength: 40,
              onChange: (stop) => props.onPatch({ stop: stop }),
            }),
            h(TextField, {
              label: '已停止文案',
              value: banner.stopped,
              maxLength: 40,
              onChange: (stopped) => props.onPatch({ stopped: stopped }),
            })
          )
        ),
        h(
          Card,
          null,
          h(CardTitle, null, '尺寸与位置'),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } },
            h(SliderField, {
              label: '宽度',
              value: banner.width,
              min: 0,
              max: 1600,
              step: 10,
              format: (value) => (value === 0 ? '自动' : value + ' px'),
              onChange: (width) => props.onPatch({ width: width }),
            }),
            h(SliderField, {
              label: '高度',
              value: banner.height,
              min: 28,
              max: 120,
              step: 1,
              suffix: ' px',
              onChange: (height) => props.onPatch({ height: height }),
            }),
            h(SliderField, {
              label: '透明度',
              value: banner.opacity,
              min: 20,
              max: 100,
              step: 1,
              suffix: '%',
              onChange: (opacity) => props.onPatch({ opacity: opacity }),
            }),
            h(SelectField, {
              label: '位置',
              value: banner.position,
              options: BANNER_POSITIONS,
              onChange: (position) => props.onPatch({ position: position }),
            }),
            custom
              ? h(NumberField, {
                  label: 'x（屏幕像素）',
                  value: banner.x == null ? '' : banner.x,
                  flex: '0 1 110px',
                  onChange: (x) => props.onPatch({ x: Math.round(x) }),
                })
              : null,
            custom
              ? h(NumberField, {
                  label: 'y（屏幕像素）',
                  value: banner.y == null ? '' : banner.y,
                  flex: '0 1 110px',
                  onChange: (y) => props.onPatch({ y: Math.round(y) }),
                })
              : null,
            custom
              ? h('button', { type: 'button', style: buttonStyle, onClick: () => props.onPatch({ x: null, y: null }) }, '恢复默认坐标')
              : null
          ),
          h(SectionNote, null, '宽度 0 表示按文字自适应；高度是胶囊高度（28–120 px）；透明度 20–100%。')
        ),
        h(
          Card,
          null,
          h(CardTitle, null, '颜色'),
          h(SectionNote, null, '颜色是 #RRGGBB；带 alpha 的背景是 #AARRGGBB（alpha 在前）。选中颜色后下方预览会立刻更新。'),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } },
            h(ColorField, { label: '背景', value: colors.bg, allowAlpha: true, onChange: (bg) => props.onPatch({ colors: { bg: bg } }) }),
            h(ColorField, { label: '正文', value: colors.text, onChange: (text) => props.onPatch({ colors: { text: text } }) }),
            h(ColorField, { label: '提示', value: colors.hint, onChange: (hint) => props.onPatch({ colors: { hint: hint } }) }),
            h(ColorField, { label: '状态点', value: colors.dot, onChange: (dot) => props.onPatch({ colors: { dot: dot } }) }),
            h(ColorField, { label: '停止按钮底', value: colors.stopBg, allowAlpha: true, onChange: (value) => props.onPatch({ colors: { stopBg: value } }) }),
            h(ColorField, { label: '停止按钮字', value: colors.stopText, onChange: (value) => props.onPatch({ colors: { stopText: value } }) }),
            h(ColorField, { label: '边框', value: colors.border, allowAlpha: true, onChange: (border) => props.onPatch({ colors: { border: border } }) })
          )
        ),
        h(
          Card,
          null,
          h(CardTitle, null, '字体'),
          h(FontPicker, { label: '正文', font: fonts.main, fonts: props.fonts, onPatch: (patch) => patchFont('main', patch) }),
          h(FontPicker, { label: '提示', font: fonts.hint, fonts: props.fonts, onPatch: (patch) => patchFont('hint', patch) }),
          h(FontPicker, { label: '停止按钮', font: fonts.stop, fonts: props.fonts, onPatch: (patch) => patchFont('stop', patch) }),
          h(SectionNote, null, '字体族未安装时会退回 Microsoft YaHei UI → Segoe UI。')
        ),
        h(
          Card,
          null,
          h(CardTitle, null, '排版'),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end' } },
            h(SelectField, {
              label: '对齐',
              value: layout.align,
              options: ALIGNS.map((item) => ({ value: item.value, label: item.label })),
              onChange: (align) => props.onPatch({ layout: { align: align } }),
            }),
            h(NumberField, { label: '水平偏移', value: layout.offsetX, onChange: (v) => props.onPatch({ layout: { offsetX: Math.round(v) } }) }),
            h(NumberField, { label: '垂直偏移', value: layout.offsetY, onChange: (v) => props.onPatch({ layout: { offsetY: Math.round(v) } }) })
          ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '8px' } },
            h(SliderField, { label: '元素间距', value: layout.gap, min: 0, max: 60, step: 1, suffix: ' px', onChange: (gap) => props.onPatch({ layout: { gap: gap } }) }),
            h(SliderField, { label: '内边距', value: layout.padding, min: 0, max: 80, step: 1, suffix: ' px', onChange: (padding) => props.onPatch({ layout: { padding: padding } }) })
          )
        ),
        h(Card, null, h(CardTitle, null, '预览'), h(BannerPreview, { banner: banner }))
      );
    }

    function ThoughtEditor(props) {
      const thought = props.thought || {};
      const fonts = thought.fonts || {};
      const colors = thought.colors || {};
      const custom = thought.position === 'custom';
      const patchFont = (key, patch) => {
        const next = {};
        next[key] = Object.assign({}, fonts[key], patch);
        props.onPatch({ fonts: next });
      };
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h(
          Card,
          null,
          h(CardTitle, null, '尺寸与位置'),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } },
            h(SliderField, { label: '宽度', value: thought.width, min: 240, max: 1600, step: 10, suffix: ' px', onChange: (width) => props.onPatch({ width: width }) }),
            h(SliderField, { label: '高度', value: thought.height, min: 160, max: 1600, step: 10, suffix: ' px', onChange: (height) => props.onPatch({ height: height }) }),
            h(SliderField, { label: '透明度', value: thought.opacity, min: 20, max: 100, step: 1, suffix: '%', onChange: (opacity) => props.onPatch({ opacity: opacity }) }),
            h(SelectField, { label: '位置', value: thought.position, options: THOUGHT_POSITIONS, onChange: (position) => props.onPatch({ position: position }) }),
            custom
              ? h(NumberField, { label: 'x（屏幕像素）', value: thought.x == null ? '' : thought.x, flex: '0 1 110px', onChange: (x) => props.onPatch({ x: Math.round(x) }) })
              : null,
            custom
              ? h(NumberField, { label: 'y（屏幕像素）', value: thought.y == null ? '' : thought.y, flex: '0 1 110px', onChange: (y) => props.onPatch({ y: Math.round(y) }) })
              : null,
            custom
              ? h('button', { type: 'button', style: buttonStyle, onClick: () => props.onPatch({ x: null, y: null }) }, '恢复默认坐标')
              : null,
            h(CheckField, { label: '锁定位置（不可拖动）', checked: thought.locked !== false, onChange: (locked) => props.onPatch({ locked: locked }) })
          ),
          h(SectionNote, null, '思考窗是右上角实时显示思考与步骤的小窗；{app} 为空时显示通用文案。')
        ),
        h(
          Card,
          null,
          h(CardTitle, null, '颜色'),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } },
            h(ColorField, { label: '背景', value: colors.bg, allowAlpha: true, onChange: (bg) => props.onPatch({ colors: { bg: bg } }) }),
            h(ColorField, { label: '边框', value: colors.border, onChange: (border) => props.onPatch({ colors: { border: border } }) }),
            h(ColorField, { label: '正文', value: colors.text, onChange: (text) => props.onPatch({ colors: { text: text } }) }),
            h(ColorField, { label: '次要文字', value: colors.muted, onChange: (muted) => props.onPatch({ colors: { muted: muted } }) }),
            h(ColorField, { label: '强调色', value: colors.accent, onChange: (accent) => props.onPatch({ colors: { accent: accent } }) })
          )
        ),
        h(
          Card,
          null,
          h(CardTitle, null, '字体'),
          h(FontPicker, { label: '标题', font: fonts.title, fonts: props.fonts, onPatch: (patch) => patchFont('title', patch) }),
          h(FontPicker, { label: '正文', font: fonts.body, fonts: props.fonts, onPatch: (patch) => patchFont('body', patch) })
        ),
        h(Card, null, h(CardTitle, null, '预览'), h(ThoughtPreview, { thought: thought }))
      );
    }

    function AuditEditor(props) {
      const audit = props.audit || {};
      const fonts = audit.fonts || {};
      const colors = audit.colors || {};
      const layout = audit.layout || {};
      const custom = audit.position === 'custom';
      const patchFont = (key, patch) => {
        const next = {};
        next[key] = Object.assign({}, fonts[key], patch);
        props.onPatch({ fonts: next });
      };
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h(
          Card,
          null,
          h(CardTitle, null, '尺寸与位置'),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' } },
            h(CheckField, { label: '显示审计窗', checked: audit.enabled !== false, onChange: (enabled) => props.onPatch({ enabled: enabled }) }),
            h(CheckField, { label: '锁定位置（不可拖动）', checked: audit.locked !== false, onChange: (locked) => props.onPatch({ locked: locked }) })
          ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '8px' } },
            h(SliderField, { label: '宽度', value: audit.width, min: 220, max: 1600, step: 10, suffix: ' px', onChange: (width) => props.onPatch({ width: width }) }),
            h(SliderField, { label: '高度', value: audit.height, min: 140, max: 1600, step: 10, suffix: ' px', onChange: (height) => props.onPatch({ height: height }) }),
            h(SliderField, { label: '透明度', value: audit.opacity, min: 20, max: 100, step: 1, suffix: '%', onChange: (opacity) => props.onPatch({ opacity: opacity }) }),
            h(SelectField, { label: '位置', value: audit.position, options: AUDIT_POSITIONS, onChange: (position) => props.onPatch({ position: position }) }),
            custom
              ? h(NumberField, { label: 'x（屏幕像素）', value: audit.x == null ? '' : audit.x, flex: '0 1 110px', onChange: (x) => props.onPatch({ x: Math.round(x) }) })
              : null,
            custom
              ? h(NumberField, { label: 'y（屏幕像素）', value: audit.y == null ? '' : audit.y, flex: '0 1 110px', onChange: (y) => props.onPatch({ y: Math.round(y) }) })
              : null,
            custom
              ? h('button', { type: 'button', style: buttonStyle, onClick: () => props.onPatch({ x: null, y: null }) }, '恢复默认坐标')
              : null
          ),
          h(SectionNote, null, 'left-of-thought 表示贴在思考窗左侧、顶边对齐；其余位置贴屏幕四角；custom 用 x / y 屏幕像素。')
        ),
        h(
          Card,
          null,
          h(CardTitle, null, '颜色'),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } },
            h(ColorField, { label: '背景', value: colors.bg, allowAlpha: true, onChange: (bg) => props.onPatch({ colors: { bg: bg } }) }),
            h(ColorField, { label: '边框', value: colors.border, onChange: (border) => props.onPatch({ colors: { border: border } }) }),
            h(ColorField, { label: '正文', value: colors.text, onChange: (text) => props.onPatch({ colors: { text: text } }) }),
            h(ColorField, { label: '次要文字', value: colors.muted, onChange: (muted) => props.onPatch({ colors: { muted: muted } }) }),
            h(ColorField, { label: '成功/强调', value: colors.accent, onChange: (accent) => props.onPatch({ colors: { accent: accent } }) }),
            h(ColorField, { label: '原因', value: colors.reason, onChange: (reason) => props.onPatch({ colors: { reason: reason } }) }),
            h(ColorField, { label: '截图', value: colors.shot, onChange: (shot) => props.onPatch({ colors: { shot: shot } }) })
          )
        ),
        h(
          Card,
          null,
          h(CardTitle, null, '字体'),
          h(FontPicker, { label: '标题', font: fonts.title, fonts: props.fonts, onPatch: (patch) => patchFont('title', patch) }),
          h(FontPicker, { label: '正文', font: fonts.body, fonts: props.fonts, onPatch: (patch) => patchFont('body', patch) })
        ),
        h(
          Card,
          null,
          h(CardTitle, null, '排版'),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end' } },
            h(NumberField, { label: '显示行数', value: layout.rows, flex: '0 1 100px', onChange: (rows) => props.onPatch({ layout: { rows: Math.round(rows) } }) }),
            h(SliderField, { label: '内边距', value: layout.padding, min: 0, max: 60, step: 1, suffix: ' px', onChange: (padding) => props.onPatch({ layout: { padding: padding } }) }),
            h(SliderField, { label: '行间距', value: layout.gap, min: 0, max: 40, step: 1, suffix: ' px', onChange: (gap) => props.onPatch({ layout: { gap: gap } }) })
          ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: '14px', marginTop: '8px' } },
            h(CheckField, { label: '显示时间', checked: layout.showTime !== false, onChange: (value) => props.onPatch({ layout: { showTime: value } }) }),
            h(CheckField, { label: '显示原因', checked: layout.showReason !== false, onChange: (value) => props.onPatch({ layout: { showReason: value } }) }),
            h(CheckField, { label: '显示截图缩略图', checked: layout.showThumb === true, onChange: (value) => props.onPatch({ layout: { showThumb: value } }) })
          )
        ),
        h(Card, null, h(CardTitle, null, '预览'), h(AuditPreview, { audit: audit }))
      );
    }

    function AuditLogEditor(props) {
      const log = props.auditLog || {};
      return h(
        Card,
        null,
        h(CardTitle, null, '审计日志'),
        h(SectionNote, null, '审计日志写在 ~/.evolution-computer-use/audit/audit-YYYY-MM-DD.jsonl，每行一次操作；这里控制保留与截图。'),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'center' } },
          h(CheckField, { label: '记录审计日志', checked: log.enabled !== false, onChange: (enabled) => props.onPatch({ enabled: enabled }) }),
          h(CheckField, { label: '保存截图', checked: log.screenshots !== false, onChange: (screenshots) => props.onPatch({ screenshots: screenshots }) })
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '8px' } },
          h(NumberField, { label: '保留天数', value: log.retentionDays, flex: '0 1 110px', onChange: (v) => props.onPatch({ retentionDays: Math.round(v) }) }),
          h(NumberField, { label: '截图总量上限（MB）', value: log.maxScreenshotsMB, flex: '0 1 150px', onChange: (v) => props.onPatch({ maxScreenshotsMB: Math.round(v) }) }),
          h(NumberField, { label: '最多条目', value: log.maxEntries, flex: '0 1 130px', onChange: (v) => props.onPatch({ maxEntries: Math.round(v) }) })
        )
      );
    }


    // --- 设置容器 -----------------------------------------------------------

    const TABS = [
      { id: 'mode', label: '模式' },
      { id: 'banner', label: '操作横幅' },
      { id: 'thought', label: '思考窗' },
      { id: 'audit', label: '审计窗' },
      { id: 'apps', label: '按应用' },
    ];

    const POLICY_MODES = [
      { value: 'inherit', label: '跟随全局' },
      { value: 'foreground', label: '只能前台' },
      { value: 'background', label: '只能后台' },
    ];

    function fetchJson(url, options) {
      return fetch(url, options).then((response) =>
        response.json().then(
          (data) => ({ status: response.status, data: data }),
          () => ({
            status: response.status,
            data: { ok: false, message: '本机接口返回了非 JSON 响应（HTTP ' + response.status + '）' },
          })
        )
      );
    }

    function AppearanceSettings(props) {
      const initialTab = props && props.initialTab ? props.initialTab : 'banner';
      const [tab, setTab] = react.useState(initialTab);
      const [appearance, setAppearance] = react.useState(null);
      const [fonts, setFonts] = react.useState({ installed: [], uploaded: [] });
      const [fontsError, setFontsError] = react.useState('');
      const [fontsBusy, setFontsBusy] = react.useState(false);
      const [error, setError] = react.useState('');
      const [busy, setBusy] = react.useState(false);
      const alive = react.useRef(true);
      const timer = react.useRef(null);
      const draft = react.useRef(null);
      const lastGood = react.useRef(null);
      const seq = react.useRef(0);

      const commit = (value) => {
        lastGood.current = value;
        draft.current = value;
        setAppearance(value);
      };

      const rollback = () => {
        if (lastGood.current) {
          draft.current = lastGood.current;
          setAppearance(lastGood.current);
        }
      };

      const save = (next, mine) => {
        fetchJson(API + '/appearance', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next),
          cache: 'no-store',
        })
          .then((result) => {
            if (!alive.current || mine !== seq.current) return;
            const data = result.data;
            if (data && data.ok && data.value) {
              commit(data.value);
              setError('');
            } else {
              rollback();
              setError((data && data.message) || '保存外观设置失败（HTTP ' + result.status + '）');
            }
          })
          .catch(() => {
            if (!alive.current || mine !== seq.current) return;
            rollback();
            setError('保存外观设置失败：本机接口没有响应');
          })
          .finally(() => {
            if (alive.current && mine === seq.current) setBusy(false);
          });
      };

      const queue = (next) => {
        const mine = seq.current + 1;
        seq.current = mine;
        draft.current = next;
        setAppearance(next);
        setBusy(true);
        setError('');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          save(draft.current, mine);
        }, 400);
      };

      const patchSection = (section, patch) => {
        const base = draft.current || appearance;
        if (!base) return;
        const next = Object.assign({}, base);
        next[section] = mergeDeep(base[section], patch);
        queue(next);
      };

      const patchRoot = (key, patch) => {
        const base = draft.current || appearance;
        if (!base) return;
        const next = Object.assign({}, base);
        next[key] = mergeDeep(base[key], patch);
        queue(next);
      };

      const loadAppearance = () => {
        setBusy(true);
        fetchJson(API + '/appearance', { cache: 'no-store' })
          .then((result) => {
            if (!alive.current) return;
            const data = result.data;
            if (data && data.ok && data.value) {
              commit(data.value);
              setError('');
            } else {
              setError((data && data.message) || '读取外观设置失败（HTTP ' + result.status + '）');
            }
          })
          .catch(() => {
            if (alive.current) setError('读取外观设置失败：本机接口没有响应');
          })
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      };

      const loadFonts = (force) => {
        setFontsBusy(true);
        fetchJson(API + '/fonts' + (force ? '?refresh=1' : ''), { cache: 'no-store' })
          .then((result) => {
            if (!alive.current) return;
            const data = result.data;
            if (data && data.ok && data.value) {
              setFonts({
                installed: Array.isArray(data.value.installed) ? data.value.installed : [],
                uploaded: Array.isArray(data.value.uploaded) ? data.value.uploaded : [],
              });
              setFontsError('');
            } else {
              setFontsError((data && data.message) || '读取字体列表失败（HTTP ' + result.status + '）');
            }
          })
          .catch(() => {
            if (alive.current) setFontsError('读取字体列表失败：本机接口没有响应');
          })
          .finally(() => {
            if (alive.current) setFontsBusy(false);
          });
      };

      const uploadFont = (payload) =>
        fetchJson(API + '/fonts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          cache: 'no-store',
        }).then((result) => result.data || { ok: false, message: 'HTTP ' + result.status });

      const deleteFont = (file) =>
        fetchJson(API + '/fonts?file=' + encodeURIComponent(file), {
          method: 'DELETE',
          cache: 'no-store',
        }).then((result) => result.data || { ok: false, message: 'HTTP ' + result.status });

      react.useEffect(() => {
        alive.current = true;
        loadAppearance();
        loadFonts(false);
        return () => {
          alive.current = false;
          if (timer.current) clearTimeout(timer.current);
        };
      }, []);

      const StatusLine = busy
        ? h('span', { style: { fontSize: '10px', opacity: 0.65 } }, '保存中…')
        : fontsBusy
          ? h('span', { style: { fontSize: '10px', opacity: 0.65 } }, '读取字体…')
          : null;

      const tabBar = h(
        'div',
        { role: 'tablist', 'aria-label': '外观设置分区', style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
        TABS.map((item) => {
          const active = tab === item.id;
          return h(
            'button',
            {
              key: item.id,
              type: 'button',
              role: 'tab',
              'aria-selected': active ? 'true' : 'false',
              onClick: (event) => {
                event.stopPropagation();
                setTab(item.id);
              },
              style: {
                fontSize: '11px',
                lineHeight: '22px',
                padding: '0 10px',
                borderRadius: '999px',
                border: '1px solid ' + (active ? 'transparent' : 'var(--dsw-alias-border-l1, rgba(128,128,128,.28))'),
                background: active ? 'var(--dsw-alias-brand-primary, #5b8def)' : 'transparent',
                color: active ? onBrandText : 'inherit',
                fontWeight: active ? 600 : 400,
                cursor: 'pointer',
              },
            },
            item.label
          );
        })
      );

      let body = null;
      if (tab === 'mode') {
        body = props && props.modeSection ? props.modeSection : null;
      } else if (tab === 'apps') {
        body = h(PerAppPanel, null);
      } else if (!appearance) {
        body = h('div', { style: hintStyle }, busy ? '正在读取外观设置…' : '还没有读取到外观设置，请点「重新读取」。');
      } else if (tab === 'banner') {
        body = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h(BannerEditor, {
            banner: appearance.banner || {},
            fonts: fonts,
            onPatch: (patch) => patchSection('banner', patch),
          }),
          fontsError ? h(ErrorLine, { text: fontsError }) : null,
          h(FontsPanel, {
            fonts: fonts,
            onRefresh: loadFonts,
            onUpload: uploadFont,
            onDelete: deleteFont,
          })
        );
      } else if (tab === 'thought') {
        body = h(ThoughtEditor, {
          thought: appearance.thought || {},
          fonts: fonts,
          onPatch: (patch) => patchSection('thought', patch),
        });
      } else if (tab === 'audit') {
        body = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h(AuditEditor, {
            audit: appearance.audit || {},
            fonts: fonts,
            onPatch: (patch) => patchSection('audit', patch),
          }),
          h(AuditLogEditor, {
            auditLog: appearance.auditLog || {},
            onPatch: (patch) => patchRoot('auditLog', patch),
          })
        );
      }

      return h(
        'div',
        {
          onClick: (event) => event.stopPropagation(),
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            marginTop: '6px',
            padding: '8px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))',
            background: 'var(--dsw-alias-bg-base, rgba(0,0,0,.06))',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '12px', fontWeight: 600 } }, '外观设置'),
          StatusLine,
          h('button', {
            type: 'button',
            style: buttonStyle,
            onClick: () => {
              loadAppearance();
              loadFonts(false);
            },
          }, '重新读取')
        ),
        tabBar,
        error ? h(ErrorLine, { text: error }) : null,
        body
      );
    }

    // --- 按应用策略 ---------------------------------------------------------

    function PerAppPanel() {
      const [windows, setWindows] = react.useState([]);
      const [policies, setPolicies] = react.useState({ version: 1, apps: [] });
      const [search, setSearch] = react.useState('');
      const [selected, setSelected] = react.useState(null);
      const [loading, setLoading] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [error, setError] = react.useState('');
      const alive = react.useRef(true);
      const seq = react.useRef(0);
      const lastGood = react.useRef({ version: 1, apps: [] });

      const apps = Array.isArray(policies.apps) ? policies.apps : [];

      const policyFor = (win) => {
        if (!win) return null;
        const exeKey = win.exe ? ('exe:' + String(win.exe)).toLowerCase() : '';
        const titleKey = win.title ? ('title:' + String(win.title)).toLowerCase() : '';
        return apps.find((item) => String(item.match || '').toLowerCase() === exeKey && exeKey)
          || apps.find((item) => String(item.match || '').toLowerCase() === titleKey && titleKey)
          || null;
      };

      const load = (force) => {
        setLoading(true);
        fetchJson(API + '/apps' + (force ? '?refresh=1' : ''), { cache: 'no-store' })
          .then((result) => {
            if (!alive.current) return;
            const data = result.data;
            if (data && data.ok && data.value) {
              const list = Array.isArray(data.value.windows) ? data.value.windows : [];
              setWindows(list);
              const nextPolicies = data.value.policies && Array.isArray(data.value.policies.apps)
                ? data.value.policies
                : { version: 1, apps: [] };
              setPolicies(nextPolicies);
              lastGood.current = nextPolicies;
              setError('');
            } else {
              setError((data && data.message) || '读取窗口列表失败（HTTP ' + result.status + '）');
            }
          })
          .catch(() => {
            if (alive.current) setError('读取窗口列表失败：本机接口没有响应');
          })
          .finally(() => {
            if (alive.current) setLoading(false);
          });
      };

      const send = (next) => {
        lastGood.current = policies;
        setPolicies(next);
        setSaving(true);
        setError('');
        const mine = seq.current + 1;
        seq.current = mine;
        fetchJson(API + '/policies', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, apps: next.apps }),
          cache: 'no-store',
        })
          .then((result) => {
            if (!alive.current || mine !== seq.current) return;
            const data = result.data;
            if (data && data.ok && data.value) {
              setPolicies(data.value);
              lastGood.current = data.value;
            } else {
              setPolicies(lastGood.current);
              setError((data && data.message) || '保存按应用策略失败（HTTP ' + result.status + '）');
            }
          })
          .catch(() => {
            if (!alive.current || mine !== seq.current) return;
            setPolicies(lastGood.current);
            setError('保存按应用策略失败：本机接口没有响应');
          })
          .finally(() => {
            if (alive.current && mine === seq.current) setSaving(false);
          });
      };

      const setModeFor = (win, mode) => {
        if (!win) return;
        const exeKey = win.exe ? ('exe:' + String(win.exe)).toLowerCase() : '';
        const titleKey = win.title ? ('title:' + String(win.title)).toLowerCase() : '';
        const keep = apps.filter((item) => {
          const key = String(item.match || '').toLowerCase();
          return (!exeKey || key !== exeKey) && (!titleKey || key !== titleKey);
        });
        const nextApps = keep.slice();
        if (mode !== 'inherit') {
          const match = win.exe ? 'exe:' + win.exe : win.title ? 'title:' + win.title : '';
          if (!match) return;
          nextApps.push({
            match: match,
            label: String(win.title || win.exe || match).trim().slice(0, 120),
            mode: mode,
          });
        }
        send({ version: 1, apps: nextApps });
      };

      const removePolicy = (policy) => {
        send({
          version: 1,
          apps: apps.filter((item) => item.match !== policy.match),
        });
      };

      react.useEffect(() => {
        alive.current = true;
        load(false);
        return () => {
          alive.current = false;
        };
      }, []);

      const keyword = search.trim().toLowerCase();
      const visible = windows.filter((win) => {
        if (!keyword) return true;
        const title = String(win.title || '').toLowerCase();
        const exe = String(win.exe || '').toLowerCase();
        return title.indexOf(keyword) >= 0 || exe.indexOf(keyword) >= 0;
      });
      const selectedWindow = selected === null ? null : windows.find((win) => win.hwnd === selected) || null;
      const selectedPolicy = selectedWindow ? policyFor(selectedWindow) : null;
      const selectedMode = selectedPolicy ? selectedPolicy.mode : 'inherit';

      const toolbar = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('input', {
          type: 'text',
          value: search,
          placeholder: '搜索标题或 exe',
          'aria-label': '搜索窗口',
          onChange: (event) => setSearch(event.target.value),
          style: Object.assign({}, boxStyle, { flex: '1 1 160px', minWidth: '120px' }),
        }),
        h('button', {
          type: 'button',
          style: buttonStyle,
          onClick: () => load(true),
          disabled: loading,
        }, loading ? '刷新中…' : '刷新窗口'),
        saving ? h('span', { style: { fontSize: '10px', opacity: 0.65 } }, '保存策略中…') : null,
        h('span', { style: { fontSize: '10px', opacity: 0.55 } }, visible.length + ' / ' + windows.length + ' 个窗口')
      );

      const selectionCard = selectedWindow
        ? h(
            Card,
            null,
            h(CardTitle, null, '已选窗口'),
            h('div', { style: { fontSize: '11px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, selectedWindow.title || '（无标题）'),
            h('div', { style: hintStyle }, (selectedWindow.exe || '未知程序') + ' · ' + selectedWindow.width + '×' + selectedWindow.height),
            h(
              'div',
              { style: { display: 'inline-flex', alignItems: 'stretch', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45))', borderRadius: '7px', overflow: 'hidden' } },
              POLICY_MODES.map((item, index) =>
                h(
                  'button',
                  {
                    key: item.value,
                    type: 'button',
                    disabled: saving,
                    onClick: () => setModeFor(selectedWindow, item.value),
                    style: {
                      fontSize: '11px',
                      lineHeight: '22px',
                      padding: '0 10px',
                      border: 'none',
                      borderLeft: index === 0 ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))',
                      background: selectedMode === item.value ? 'var(--dsw-alias-brand-primary, #5b8def)' : 'transparent',
                      color: selectedMode === item.value ? onBrandText : 'inherit',
                      fontWeight: selectedMode === item.value ? 600 : 400,
                      cursor: saving ? 'progress' : 'pointer',
                    },
                  },
                  item.label
                )
              )
            ),
            h('div', { style: hintStyle },
              selectedMode === 'foreground'
                ? '该程序的操作会先请求管理员助手（UAC），用户拒绝则操作失败。'
                : selectedMode === 'background'
                  ? '该程序的操作会降到后台模式，不动用户的鼠标键盘。'
                  : '使用上方「模式」里的全局设置；保存后会删掉该程序的前后台策略。'
            )
          )
        : h('div', { style: hintStyle }, '点击下方窗口卡片，为它指定跟随全局 / 只能前台 / 只能后台。');

      const grid = h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '8px' } },
        visible.map((win) => {
          const policy = policyFor(win);
          const active = selected === win.hwnd;
          return h(
            'button',
            {
              key: win.hwnd,
              type: 'button',
              onClick: () => setSelected(win.hwnd),
              title: win.title || win.exe,
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                textAlign: 'left',
                padding: '6px',
                borderRadius: '8px',
                background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,.12))',
                border: active
                  ? '2px solid var(--dsw-alias-brand-primary, #5b8def)'
                  : '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))',
                cursor: 'pointer',
                color: 'inherit',
                overflow: 'hidden',
              },
            },
            win.thumbnail
              ? h('img', {
                  src: win.thumbnail,
                  alt: '',
                  style: { width: '100%', height: '86px', objectFit: 'cover', borderRadius: '5px', background: '#0b0d12', display: 'block' },
                })
              : h('div', {
                  style: { width: '100%', height: '86px', borderRadius: '5px', background: 'var(--dsw-alias-bg-module-platform, rgba(0,0,0,.2))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', opacity: 0.4 },
                }, '🪟'),
            h('div', { style: { fontSize: '11px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, win.title || '（无标题）'),
            h('div', { style: { fontSize: '10px', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              (win.exe || '') + (win.minimized ? ' · 最小化' : '')
            ),
            policy
              ? h('div', {
                  style: { alignSelf: 'flex-start', fontSize: '10px', lineHeight: '15px', padding: '0 6px', borderRadius: '999px', background: policy.mode === 'foreground' ? 'rgba(91,141,239,.22)' : 'rgba(74,222,128,.18)', color: 'inherit' },
                }, policy.mode === 'foreground' ? '只能前台' : '只能后台')
              : h('div', { style: { fontSize: '10px', opacity: 0.45 } }, '跟随全局')
          );
        })
      );

      const policyList = h(
        Card,
        null,
        h(CardTitle, null, '已保存的按应用策略'),
        h('div', { style: hintStyle }, '匹配顺序：exe: → title:（app: 由 agent 打开的名字记录，也可在这里删除）。先匹配先赢，未被匹配的程序用全局模式。'),
        apps.length
          ? apps.map((policy, index) =>
              h(
                'div',
                { key: String(policy.match) + '#' + index, style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', flexWrap: 'wrap' } },
                h('span', { style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '10px', opacity: 0.8 } }, policy.match),
                h('span', { style: { flex: '1 1 100px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, policy.label || ''),
                h('span', { style: { opacity: 0.7 } }, policy.mode === 'foreground' ? '只能前台' : '只能后台'),
                h('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => removePolicy(policy) }, '删除')
              )
            )
          : h('div', { style: hintStyle }, '还没有按应用策略。')
      );

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h(Card, null,
          h(CardTitle, null, '按应用策略'),
          h('div', { style: hintStyle }, '仿 OBS 窗口捕捉：选择要控制的程序窗口，指定它只能前台或只能后台；未指定的程序沿用全局模式。'),
          error ? h(ErrorLine, { text: error }) : null,
          toolbar
        ),
        selectionCard,
        loading && !windows.length
          ? h('div', { style: hintStyle }, '正在枚举可见窗口…')
          : windows.length
            ? grid
            : h('div', { style: hintStyle }, '没有可选择的窗口。先把要控制的程序窗口打开，再点「刷新窗口」。'),
        policyList
      );
    }

    const inject = ['slots'];

    function apply(ctx) {
      const register = (name, key, order) => {
        try {
          ctx.slots.inject(name, () =>
            ctx.slots.register({ name, key, order }, (slotProps) => h(DesktopModeControl, { view: slotProps && slotProps.view }))
          );
        } catch (error) {
          console.error('[evolution-desktop-mode] 注册插槽失败：', name, error);
        }
      };
      // 已安装插件列表：这一行右侧的配置控件（key 规则：<包名>#<patch 里的 entry id>）
      register('plugins.row.config', 'evolution-computer-use-win#evolution-desktop-mode', 10);
      // 插件详情页的配置区（key = 包名）
      register('plugins.bundle.config', 'evolution-computer-use-win', 10);
    }

    exports.name = 'evolution-desktop-mode';
    exports.apply = apply;
    exports.inject = inject;
    exports.DesktopModeControl = DesktopModeControl;
    exports.AppearanceSettings = AppearanceSettings;
    exports.PerAppPanel = PerAppPanel;
    // 兼容旧导出名：以前只有浮窗设置，现在并入了完整外观设置。
    exports.OverlaySettings = AppearanceSettings;
    return module.exports;
  },
});
