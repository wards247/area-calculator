// pages/index/index.js

Page({
  data: {
    // UI 状态
    imgSrc: '',
    tracing: false,
    showDoneBtn: false,
    showClearBtn: false,
    showGridBtn: false,
    gridOn: false,
    showRatioPanel: false,
    showTraceTip: false,
    traceTipText: '点击图片描出边界\n双击或点击起点闭合',
    hintText: '第一步：点击「描边」，在图上点出地块边界',
    canUndo: false,

    // 面积
    totalArea: '1.12',
    ptCount: '0',
    totalCellCount: '0',
    cellCount: '0',
    areaVal: '0.000亩',
    areaSub: '0.0㎡',

    // 比例
    ratioA: 60,
    ratioB: 40,
    ratioPct: '--%',
    ratioACells: 0,
    ratioBCells: 0,
    ratioAArea: '0.000亩',
    ratioBArea: '0.000亩',
  },

  // ==================== 内部状态 ====================
  imgW: 0,
  imgH: 0,
  dispW: 0,
  dispH: 0,
  offsetX: 0,
  offsetY: 0,
  scale: 1,

  tracing: false,
  points: [],
  polygon: null,
  gridOn: false,
  selectedCells: {},

  // canvas
  traceCanvas: null,
  traceCtx: null,
  gridCanvas: null,
  gridCtx: null,

  // 比例
  ratioActive: null,
  ratioSplit: 0,
  sortedCellKeys: [],

  totalAreaMu: 1.12,
  GRID: 20,

  // 拖拽
  dragging: false,
  dragMode: null,
  dragVisited: {},

  // 双击检测
  _lastTapTime: 0,

  // ==================== 生命周期 ====================
  onLoad() {},
  onReady() {
    this.initCanvas();
  },

  // ==================== Canvas 初始化 ====================
  initCanvas() {
    const query = wx.createSelectorQuery();
    query.select('#trace-canvas').fields({ node: true, size: true });
    query.select('#grid-canvas').fields({ node: true, size: true });
    query.exec((res) => {
      if (res && res[0]) {
        this.traceCanvas = res[0].node;
        this.traceCtx = this.traceCanvas.getContext('2d');
      }
      if (res && res[1]) {
        this.gridCanvas = res[1].node;
        this.gridCtx = this.gridCanvas.getContext('2d');
      }
      if (this.traceCanvas && this.gridCanvas) {
        this.resize();
      }
    });
  },

  // ==================== 图片上传 ====================
  onChooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFiles[0].tempFilePath;
        this.setData({ imgSrc: tempFilePath, hintText: '图片已加载，点击「描边」开始描边' });
      }
    });
  },

  noop() {},

  onImgLoad(e) {
    const { width, height } = e.detail;
    this.imgW = width;
    this.imgH = height;
    this.resize();
  },

  // ==================== 尺寸计算 ====================
  resize() {
    if (!this.traceCanvas || !this.gridCanvas) return;
    const query = wx.createSelectorQuery();
    query.select('#map-area').boundingClientRect().exec((res) => {
      if (!res || !res[0]) return;
      const rect = res[0];
      this.dispW = Math.round(rect.width);
      this.dispH = Math.round(rect.height);

      const imgRatio = this.imgW / this.imgH;
      const areaRatio = this.dispW / this.dispH;
      if (imgRatio > areaRatio) {
        this.scale = this.dispW / this.imgW;
        this.offsetX = 0;
        this.offsetY = (this.dispH - this.imgH * this.scale) / 2;
      } else {
        this.scale = this.dispH / this.imgH;
        this.offsetX = (this.dispW - this.imgW * this.scale) / 2;
        this.offsetY = 0;
      }

      this.traceCanvas.width = this.dispW;
      this.traceCanvas.height = this.dispH;
      this.gridCanvas.width = this.dispW;
      this.gridCanvas.height = this.dispH;

      this.redrawTrace();
      if (this.polygon) {
        this.drawGridSelected();
        if (this.ratioActive) {
          this.computeSortedCells();
          this.applyRatio(this.ratioActive.a, this.ratioActive.b);
        }
      }
    });
  },

  // ==================== 坐标转换 ====================
  dispToImg(dx, dy) {
    return [(dx - this.offsetX) / this.scale, (dy - this.offsetY) / this.scale];
  },
  imgToDisp(ix, iy) {
    return [ix * this.scale + this.offsetX, iy * this.scale + this.offsetY];
  },

  // ==================== 描边绘制 ====================
  redrawTrace() {
    if (!this.traceCtx || this.points.length === 0) {
      if (this.traceCtx) this.traceCtx.clearRect(0, 0, this.dispW, this.dispH);
      return;
    }
    const ctx = this.traceCtx;
    ctx.clearRect(0, 0, this.dispW, this.dispH);

    ctx.beginPath();
    const [sx, sy] = this.imgToDisp(this.points[0].x, this.points[0].y);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < this.points.length; i++) {
      const [px, py] = this.imgToDisp(this.points[i].x, this.points[i].y);
      ctx.lineTo(px, py);
    }
    if (this.polygon) ctx.closePath();
    ctx.strokeStyle = '#d32f2f';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    if (this.polygon) {
      ctx.fillStyle = 'rgba(46,125,50,0.12)';
      ctx.fill();
    }

    this.points.forEach((p, i) => {
      const [px, py] = this.imgToDisp(p.x, p.y);
      ctx.beginPath();
      ctx.arc(px, py, i === 0 ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#d32f2f' : '#ff8a65';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  },

  // ==================== 网格计算 ====================
  countCellsInPolygon() {
    if (!this.polygon) return 0;
    const minX = Math.min(...this.polygon.map(p => p.x));
    const maxX = Math.max(...this.polygon.map(p => p.x));
    const minY = Math.min(...this.polygon.map(p => p.y));
    const maxY = Math.max(...this.polygon.map(p => p.y));
    const gridSize = this.GRID / this.scale;
    let count = 0;
    for (let gy = Math.floor(minY / gridSize); gy <= Math.ceil(maxY / gridSize); gy++) {
      for (let gx = Math.floor(minX / gridSize); gx <= Math.ceil(maxX / gridSize); gx++) {
        const cx = gx * gridSize + gridSize / 2;
        const cy = gy * gridSize + gridSize / 2;
        if (this.pointInPolygon(cx, cy, this.polygon)) count++;
      }
    }
    return count;
  },

  pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  },

  // ==================== 描边交互 ====================
  onTraceToggle() {
    this.tracing = !this.tracing;
    this.setData({
      tracing: this.tracing,
      showDoneBtn: this.tracing,
      canUndo: this.tracing && this.points.length > 0,
      hintText: this.tracing ? '在图上点出边界，双击完成描边' : '第一步：点击「描边」，在图上点出地块边界',
      showTraceTip: this.tracing,
    });
  },

  onTraceTouchStart(e) {
    if (!this.tracing) return;
    const touch = e.touches[0];
    this.handleTraceStart(touch.x, touch.y);
  },

  onTraceTouchMove() {},

  onTraceTouchEnd() {
    const now = Date.now();
    if (this._lastTapTime && now - this._lastTapTime < 300 && this.tracing && this.points.length >= 3) {
      this.finishTrace();
    }
    this._lastTapTime = now;
  },

  handleTraceStart(dx, dy) {
    const [ix, iy] = this.dispToImg(dx, dy);

    if (this.points.length >= 3) {
      const [sx, sy] = this.imgToDisp(this.points[0].x, this.points[0].y);
      const dist = Math.hypot(dx - sx, dy - sy);
      if (dist < 20) {
        this.finishTrace();
        return;
      }
    }

    this.points.push({ x: ix, y: iy });
    this.setData({
      ptCount: String(this.points.length),
      canUndo: true,
    });
    this.redrawTrace();
  },

  finishTrace() {
    if (this.points.length < 3) {
      wx.showToast({ title: '至少需要3个点', icon: 'none' });
      return;
    }
    this.polygon = [...this.points];
    this.tracing = false;
    this.setData({
      tracing: false,
      showDoneBtn: false,
      canUndo: false,
      showClearBtn: true,
      showGridBtn: true,
      showRatioPanel: true,
      showTraceTip: false,
    });

    this.redrawTrace();

    // 双 nextTick 确保比例面板渲染完成后 map-area 尺寸已稳定，再重算 canvas
    wx.nextTick(() => {
      wx.nextTick(() => {
        this.resize();
      });
    });

    this.computeSortedCells();
    this.updateRatioDisplay();

    // 自动显示网格
    setTimeout(() => {
      this.gridOn = true;
      this.setData({
        gridOn: true,
        hintText: '在格子上按住滑动即可选择/取消。修改顶部总面积可重新校准。',
      });
      this.drawGridSelected();
    }, 350);
  },

  onUndo() {
    if (this.points.length > 0) {
      this.points.pop();
      this.setData({
        ptCount: String(this.points.length),
        canUndo: this.points.length > 0,
      });
      this.redrawTrace();
    }
  },

  onDone() {
    if (this.points.length >= 3) this.finishTrace();
  },

  onClear() {
    wx.showModal({
      title: '确认清空',
      content: '确定要清空所有描边吗？',
      success: (res) => {
        if (res.confirm) {
          this.points = [];
          this.polygon = null;
          this.selectedCells = {};
          this.tracing = false;
          this.gridOn = false;
          this.ratioActive = null;
          this.ratioSplit = 0;
          this.dragVisited = {};

          this.setData({
            tracing: false,
            showDoneBtn: false,
            canUndo: false,
            showClearBtn: false,
            showGridBtn: false,
            gridOn: false,
            showRatioPanel: false,
            showTraceTip: false,
            ptCount: '0',
            totalCellCount: '0',
            cellCount: '0',
            areaVal: '0.000亩',
            areaSub: '0.0㎡',
            hintText: '第一步：点击「描边」，在图上点出地块边界',
          });

          if (this.traceCtx) this.traceCtx.clearRect(0, 0, this.dispW, this.dispH);
          if (this.gridCtx) this.gridCtx.clearRect(0, 0, this.dispW, this.dispH);

          // 隐藏比例面板后 map-area 宽度恢复，需重算
          wx.nextTick(() => {
            wx.nextTick(() => {
              this.resize();
            });
          });
        }
      }
    });
  },

  onGridToggle() {
    this.gridOn = !this.gridOn;
    this.setData({
      gridOn: this.gridOn,
    });
    if (this.gridOn) {
      this.drawGridSelected();
    }
  },

  // ==================== 网格选择交互 ====================
  onGridTouchStart(e) {
    if (!this.polygon || !this.gridOn) return;
    const touch = e.touches[0];
    this.handleGridStart(touch.x, touch.y);
  },

  onGridTouchMove(e) {
    if (!this.dragging) return;
    const touch = e.touches[0];
    this.handleGridMove(touch.x, touch.y);
  },

  onGridTouchEnd() {
    this.dragging = false;
    this.dragMode = null;
    this.dragVisited = {};
  },

  handleGridStart(dx, dy) {
    if (!this.polygon || !this.gridOn) return;
    if (this.ratioActive) this.clearRatio();

    const [ix, iy] = this.dispToImg(dx, dy);
    const gridSize = this.GRID / this.scale;
    const gx = Math.floor(ix / gridSize);
    const gy = Math.floor(iy / gridSize);
    const key = `${gx},${gy}`;
    const cx = gx * gridSize + gridSize / 2;
    const cy = gy * gridSize + gridSize / 2;
    if (!this.pointInPolygon(cx, cy, this.polygon)) return;

    this.dragging = true;
    this.dragMode = this.selectedCells[key] ? 'del' : 'add';
    this.toggleCell(gx, gy);
  },

  handleGridMove(dx, dy) {
    if (!this.dragging) return;
    const [ix, iy] = this.dispToImg(dx, dy);
    const gridSize = this.GRID / this.scale;
    const gx = Math.floor(ix / gridSize);
    const gy = Math.floor(iy / gridSize);
    this.toggleCell(gx, gy);
  },

  toggleCell(gx, gy) {
    const key = `${gx},${gy}`;
    const gridSize = this.GRID / this.scale;
    const cx = gx * gridSize + gridSize / 2;
    const cy = gy * gridSize + gridSize / 2;
    if (!this.pointInPolygon(cx, cy, this.polygon)) return;

    if (this.dragMode === 'add') {
      this.selectedCells[key] = true;
    } else {
      delete this.selectedCells[key];
    }
    this.drawGridSelected();
    this.updateArea();
  },

  drawGridSelected() {
    if (!this.gridCtx || !this.polygon) {
      if (this.gridCtx) this.gridCtx.clearRect(0, 0, this.dispW, this.dispH);
      return;
    }

    const ctx = this.gridCtx;
    ctx.clearRect(0, 0, this.dispW, this.dispH);

    const gridSize = this.GRID / this.scale;
    const minX = Math.min(...this.polygon.map(p => p.x));
    const maxX = Math.max(...this.polygon.map(p => p.x));
    const minY = Math.min(...this.polygon.map(p => p.y));
    const maxY = Math.max(...this.polygon.map(p => p.y));

    const useRatio = this.ratioActive !== null;
    const aSet = new Set(this.sortedCellKeys.slice(0, this.ratioSplit));

    for (let gy = Math.floor(minY / gridSize); gy <= Math.ceil(maxY / gridSize); gy++) {
      for (let gx = Math.floor(minX / gridSize); gx <= Math.ceil(maxX / gridSize); gx++) {
        const cx = gx * gridSize + gridSize / 2;
        const cy = gy * gridSize + gridSize / 2;
        if (!this.pointInPolygon(cx, cy, this.polygon)) continue;

        const [sx, sy] = this.imgToDisp(gx * gridSize, gy * gridSize);
        const gs = this.GRID;
        const key = `${gx},${gy}`;

        if (useRatio) {
          const inA = aSet.has(key);
          ctx.fillStyle = inA ? 'rgba(33,150,243,0.45)' : 'rgba(255,152,0,0.4)';
          ctx.fillRect(sx + 0.5, sy + 0.5, gs - 1, gs - 1);
          ctx.strokeStyle = inA ? 'rgba(21,101,192,0.75)' : 'rgba(230,81,0,0.75)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(sx + 0.5, sy + 0.5, gs - 1, gs - 1);
        } else {
          const isSelected = !!this.selectedCells[key];
          ctx.fillStyle = isSelected ? 'rgba(46,125,50,0.55)' : 'rgba(102,187,106,0.3)';
          ctx.fillRect(sx + 0.5, sy + 0.5, gs - 1, gs - 1);
          ctx.strokeStyle = isSelected ? 'rgba(27,94,32,0.8)' : 'rgba(46,125,50,0.75)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(sx + 0.5, sy + 0.5, gs - 1, gs - 1);
        }
      }
    }

    // 比例模式分界虚线
    if (useRatio && this.ratioSplit > 0 && this.ratioSplit < this.sortedCellKeys.length) {
      const lastA = this.sortedCellKeys[this.ratioSplit - 1];
      const [agx, agy] = lastA.split(',').map(Number);
      const [asx, asy] = this.imgToDisp(agx * gridSize, agy * gridSize);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(asx + 0.5, asy + 0.5, this.GRID - 1, this.GRID - 1);
      ctx.setLineDash([]);
    }

    this.updateArea();
  },

  // ==================== 比例填充 ====================
  computeSortedCells() {
    if (!this.polygon) { this.sortedCellKeys = []; return; }
    const gridSize = this.GRID / this.scale;
    const minX = Math.min(...this.polygon.map(p => p.x));
    const maxX = Math.max(...this.polygon.map(p => p.x));
    const minY = Math.min(...this.polygon.map(p => p.y));
    const maxY = Math.max(...this.polygon.map(p => p.y));
    const cells = [];
    for (let gy = Math.floor(minY / gridSize); gy <= Math.ceil(maxY / gridSize); gy++) {
      for (let gx = Math.floor(minX / gridSize); gx <= Math.ceil(maxX / gridSize); gx++) {
        const cx = gx * gridSize + gridSize / 2;
        const cy = gy * gridSize + gridSize / 2;
        if (this.pointInPolygon(cx, cy, this.polygon)) {
          cells.push(`${gx},${gy}`);
        }
      }
    }
    this.sortedCellKeys = cells;
  },

  onRatioPreset(e) {
    const a = parseInt(e.currentTarget.dataset.a);
    const b = parseInt(e.currentTarget.dataset.b);
    this.applyRatio(a, b);
  },

  onRatioAInput(e) {
    let a = parseInt(e.detail.value) || 60;
    a = Math.max(1, Math.min(99, a));
    this.setData({ ratioA: a });
  },

  onRatioCustom() {
    const a = this.data.ratioA;
    this.applyRatio(a, 100 - a);
  },

  applyRatio(a, b) {
    if (!this.polygon) return;
    this.computeSortedCells();
    const total = this.sortedCellKeys.length;
    if (total === 0) return;

    this.ratioSplit = Math.round(total * a / (a + b));
    this.ratioSplit = Math.max(0, Math.min(total, this.ratioSplit));
    this.ratioActive = { a, b };

    this.setData({
      ratioA: a,
      ratioB: b,
    });

    this.drawGridSelected();
    this.updateRatioDisplay();
  },

  clearRatio() {
    this.ratioActive = null;
    this.ratioSplit = 0;
    this.selectedCells = {};
    this.drawGridSelected();
    this.updateRatioDisplay();
    this.updateArea();
  },

  updateRatioDisplay() {
    if (!this.polygon || this.sortedCellKeys.length === 0) {
      this.setData({
        ratioPct: '--%',
        ratioACells: 0,
        ratioBCells: 0,
        ratioAArea: '0.000亩',
        ratioBArea: '0.000亩',
      });
      return;
    }
    const total = this.sortedCellKeys.length;
    const aCells = this.ratioActive ? this.ratioSplit : Object.keys(this.selectedCells).length;
    const bCells = total - aCells;
    const pct = total > 0 ? (aCells / total * 100).toFixed(1) : 0;
    const cellMu = this.totalAreaMu / total;
    const aArea = (aCells * cellMu).toFixed(3);
    const bArea = (bCells * cellMu).toFixed(3);

    this.setData({
      ratioPct: pct + '%',
      ratioACells: aCells,
      ratioBCells: bCells,
      ratioAArea: aArea + '亩',
      ratioBArea: bArea + '亩',
    });
  },

  // ==================== 面积计算 ====================
  updateArea() {
    if (!this.polygon) return;
    const totalCells = this.countCellsInPolygon();
    const cellMu = this.totalAreaMu / totalCells;
    const cellSqm = this.totalAreaMu * 666.6667 / totalCells;
    const sel = this.ratioActive ? this.ratioSplit : Object.keys(this.selectedCells).length;
    const areaMu = sel * cellMu;
    const areaSqm = sel * cellSqm;

    this.setData({
      totalCellCount: String(totalCells),
      cellCount: String(sel),
      areaVal: areaMu.toFixed(3) + '亩',
      areaSub: areaSqm.toFixed(1) + '㎡',
    });
    this.updateRatioDisplay();
  },

  onTotalAreaInput(e) {
    const v = parseFloat(e.detail.value);
    if (!isNaN(v) && v > 0) {
      this.totalAreaMu = v;
    }
    if (this.polygon) this.drawGridSelected();
  },

  onTotalAreaBlur(e) {
    const v = parseFloat(e.detail.value);
    if (isNaN(v) || v <= 0) {
      this.setData({ totalArea: this.totalAreaMu.toFixed(2) });
    }
  },
})
