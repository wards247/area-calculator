# A24 地块面积计算器 — 网格图层实现详解

> 从零到一个能用的网格面积计算工具，每一步怎么想的、怎么做的、踩了什么坑。

---

## 目录

1. [问题是什么](#一问题是什么)
2. [整体架构：三层叠加](#二整体架构三层叠加)
3. [坐标系统：三个空间的转换](#三坐标系统三个空间的转换)
4. [描边：从点击到多边形](#四描边从点击到多边形)
5. [网格生成：怎么决定哪里放格子](#五网格生成怎么决定哪里放格子)
6. [点在多边形内：射线法](#六点在多边形内射线法)
7. [面积计算：一个格子值多少亩](#七面积计算一个格子值多少亩)
8. [比例填充：自动按比例划分A/B区](#八比例填充自动按比例划分ab区)
9. [手动微调：在自动分配基础上翻转格子](#九手动微调在自动分配基础上翻转格子)
10. [踩过的坑](#十踩过的坑)
11. [设计决策回顾](#十一设计决策回顾)

---

## 一、问题是什么

用户有一张地块规划图（A24地块，1.12亩），需要：

1. 在图上描出地块边界
2. 用正方形网格覆盖这个边界
3. 滑动选择格子，实时计算选中区域的面积

听起来简单，但涉及几个技术点：
- Canvas 坐标和图片坐标的转换
- 任意多边形的点包含判断
- 鼠标/触摸拖拽选格
- 移动端适配
- 布局变化时的 canvas 重算

---

## 二、整体架构：三层叠加

页面上的地图区域，其实是三层东西叠在一起：

```
┌─────────────────────────────────┐
│  z-index: 1   <img> 底图        │  ← 用户看到的地图照片
├─────────────────────────────────┤
│  z-index: 2   trace-canvas      │  ← 描边画的红线和红点
├─────────────────────────────────┤
│  z-index: 3   grid-canvas       │  ← 绿色/蓝橙色格子
└─────────────────────────────────┘
```

**为什么用三层而不是一个canvas？**

因为底图是 `<img>` 标签，CSS `object-fit: contain` 能自动处理图片缩放和居中。如果画在 canvas 上，就得自己算缩放比和居中偏移——容易出错，且图片质量不如浏览器原生渲染。

两个 canvas 叠在上面，各管各的：
- `trace-canvas`：画描边的红线、红点、闭合后的半透明填充
- `grid-canvas`：画格子、选中的高亮、比例分界线

分层的好处是：描边时只重绘 trace-canvas，格子不受影响；选格时只重绘 grid-canvas，描边不受影响。互不干扰。

---

## 三、坐标系统：三个空间的转换

这是整个项目最关键也最容易出 bug 的部分。一共有三个坐标空间：

### 1. 屏幕坐标（Screen Space）

鼠标事件给的是相对于浏览器视口的位置 `e.clientX, e.clientY`。

需要减去 canvas 在页面中的偏移，得到相对于 canvas 左上角的位置：

```javascript
const rect = canvas.getBoundingClientRect();
const dx = e.clientX - rect.left;
const dy = e.clientY - rect.top;
```

这个 `dx, dy` 就是**显示坐标**。

### 2. 显示坐标（Display Space）

canvas 上的像素坐标。canvas 的 `width/height` 决定了 drawing buffer 大小，CSS 的 `width/height` 决定了显示大小。两者必须一致，否则会拉伸变形。

### 3. 图片坐标（Image Space）

图片原始像素的坐标。为什么要用图片坐标？因为描边的点和格子的位置需要在不同屏幕尺寸下保持一致——手机上描的点，在电脑上打开应该对应同一个地块位置。

### 转换公式

图片在容器中按 `object-fit: contain` 显示，意味着：
- 图片等比缩放，不留变形
- 多余的空间居中分配

所以有两个参数：
- `scale`：缩放比 = 显示尺寸 / 图片原始尺寸
- `offsetX, offsetY`：图片在容器中的居中偏移

```javascript
// 显示坐标 → 图片坐标
function dispToImg(dx, dy) {
  return [(dx - offsetX) / scale, (dy - offsetY) / scale];
}

// 图片坐标 → 显示坐标
function imgToDisp(ix, iy) {
  return [ix * scale + offsetX, iy * scale + offsetY];
}
```

**核心设计决策**：所有描边点和格子位置都存储为图片坐标，绘制时才转成显示坐标。这样无论屏幕怎么变，数据不变。

---

## 四、描边：从点击到多边形

用户点击地图，每次点击记录一个点（图片坐标）：

```javascript
points.push({ x: ix, y: iy });
```

绘制时把每个点转回显示坐标，连线：

```javascript
const [sx, sy] = imgToDisp(points[0].x, points[0].y);
ctx.moveTo(sx, sy);
for (let i = 1; i < points.length; i++) {
  const [px, py] = imgToDisp(points[i].x, points[i].y);
  ctx.lineTo(px, py);
}
```

**闭合条件**：当用户点击的位置距离第一个点 < 20px 时，自动闭合：

```javascript
if (points.length >= 3) {
  const dist = Math.hypot(dx - sx, dy - sy);
  if (dist < 20) finishTrace();
}
```

闭合后，`polygon = [...points]`，从此进入网格模式。

---

## 五、网格生成：怎么决定哪里放格子

这是核心问题：**给定一个多边形，怎么用正方形网格覆盖它？**

### 思路

不是遍历整个画布的每一个格子——那样太慢。而是：

1. 先算出多边形的**包围盒**（Bounding Box）
2. 只在包围盒范围内遍历格子
3. 每个格子取**中心点**，判断是否在多边形内
4. 在内的就画，不在的跳过

### 代码

```javascript
const gridSize = GRID / scale;  // 图片坐标系下的格子大小

// 多边形的包围盒
const minX = Math.min(...polygon.map(p => p.x));
const maxX = Math.max(...polygon.map(p => p.x));
const minY = Math.min(...polygon.map(p => p.y));
const maxY = Math.max(...polygon.map(p => p.y));

// 遍历包围盒内的所有格子
for (let gy = Math.floor(minY / gridSize); gy <= Math.ceil(maxY / gridSize); gy++) {
  for (let gx = Math.floor(minX / gridSize); gx <= Math.ceil(maxX / gridSize); gx++) {
    // 格子中心点（图片坐标）
    const cx = gx * gridSize + gridSize / 2;
    const cy = gy * gridSize + gridSize / 2;
    
    // 中心点在多边形内？
    if (pointInPolygon(cx, cy, polygon)) {
      // 画这个格子
    }
  }
}
```

### 为什么用中心点判断？

这是最简单的策略：**格子中心在多边形内 → 整格算入**。

优点：
- 实现简单
- 每格要么算要么不算，不存在分数格
- 对面积估算足够准确（误差在边界，大数定律自动平均）

缺点：
- 边界格子可能有误差：中心刚好在边界外面的格子会被丢弃，即使它有一半面积在多边形内
- 这就是用户提到的"四分小格"优化方向——在边界处细分以减小误差

### 格子大小的选择

```javascript
const GRID = 20;  // 显示像素
```

20px 是经过调试的选择：
- 太大（40px）：格子太少，面积精度差
- 太小（10px）：格子太多，手机操作点不准，且性能下降
- 20px：大约30-50格覆盖一个1亩的地块，精度够用，操作友好

注意：`GRID = 20` 是显示像素，转换到图片坐标时除以 `scale`。这样无论屏幕大小，格子数量基本一致。

---

## 六、点在多边形内：射线法

这是计算几何的经典算法。

### 原理

从待测点向右水平射出一条射线，计算它穿过 polygon 边界的次数：
- 奇数次 → 点在内部
- 偶数次 → 点在外部

```
        ╱
       ╱
  ───→╱────── 射线穿过1条边 → 奇数 → 内部
     ╱
    ╱

  ───→──────── 射线穿过0条边 → 偶数 → 外部
```

### 代码

```javascript
function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    
    // 判断射线是否穿过这条边
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    
    if (intersect) inside = !inside;
  }
  return inside;
}
```

### 逐行解释

**`(yi > y) !== (yj > y)`**

这条边的两个端点，一个在待测点上方，一个在下方——只有这种边才可能被水平射线穿过。如果两个端点都在上方或都在下方，射线不可能穿过这条边。

**`x < (xj - xi) * (y - yi) / (yj - yi) + xi`**

这是一个线性插值：在边的 y=yi 到 y=yj 之间，找到 y=待测点y 时，边上的 x 坐标是多少。如果这个 x 大于待测点的 x，说明交点在待测点右侧，射线穿过了。

**`inside = !inside`**

每穿过一条边，翻转一次。最终奇数次=内部，偶数次=外部。

### 边界情况

- 点正好在边上：算法结果不确定（奇偶取决于浮点精度），但实际影响极小
- 多边形自相交：算法仍然有效，但"内部"的定义取决于奇偶规则
- 凹多边形：完全支持，射线法天然处理凹凸

---

## 七、面积计算：一个格子值多少亩

### 公式

```
单格面积（亩）= 总面积（亩）÷ 总格数
选中面积（亩）= 选中格数 × 单格面积
```

### 为什么不是按像素面积算？

因为图片的比例尺是未知的——我们不知道图上1像素对应实际多少米。但我们知道**整个多边形 = 1.12亩**，所以用相对比例算：

```
每格占总面积的 1/总格数
```

这就是"数格子法"的本质：**不关心绝对尺寸，只关心相对占比**。

### 代码

```javascript
function updateArea() {
  const totalCells = countCellsInPolygon();
  const cellMu = totalAreaMu / totalCells;        // 每格多少亩
  const cellSqm = totalAreaMu * 666.6667 / totalCells;  // 每格多少㎡（1亩≈666.67㎡）
  
  const sel = selectedCells.size;
  const areaMu = sel * cellMu;
  const areaSqm = sel * cellSqm;
  
  // 更新UI
  document.getElementById('area-val').textContent = areaMu.toFixed(3) + '亩';
  document.getElementById('area-sub').textContent = areaSqm.toFixed(1) + '㎡';
}
```

### 面积可编辑

顶部有一个输入框，默认1.12亩。用户改了总面积后，所有计算自动更新——因为每格面积是从总面积除出来的。

---

## 八、比例填充：自动按比例划分A/B区

### 需求

用户选完60/40比例后，自动把格子分成两部分：
- A区（60%）：蓝色
- B区（40%）：橙色

### 怎么分？

**行优先扫描**：从左上角开始，逐行从左到右扫描所有在多边形内的格子，排成一个一维列表。前60%标蓝，后40%标橙。

```javascript
function computeSortedCells() {
  const cells = [];
  for (let gy = minY格; gy <= maxY格; gy++) {
    for (let gx = minX格; gx <= maxX格; gx++) {
      if (pointInPolygon(中心点, polygon)) {
        cells.push(`${gx},${gy}`);
      }
    }
  }
  sortedCellKeys = cells;  // 遍历顺序天然是行优先
}
```

**分界点**：

```javascript
ratioSplit = Math.round(total * a / (a + b));
// 例如 50格 × 60% = 30格 → 前30个是A区
```

**绘制时判断**：

```javascript
const aSet = new Set(sortedCellKeys.slice(0, ratioSplit));
// 遍历格子时
const inA = aSet.has(key);
ctx.fillStyle = inA ? '蓝色' : '橙色';
```

### 为什么用行优先而不是列优先？

行优先（从上到下，每行从左到右）更符合人的视觉习惯——读中文、读英文都是从左到右、从上到下。分配A区时，用户直觉上期望从左上方开始填蓝色。

---

## 九、手动微调：在自动分配基础上翻转格子

### 问题

自动分配后，用户可能觉得某个格子应该归A区而不是B区。但原来的实现是：一点击就清空比例模式。

### 解决方案

引入 `ratioSwapSet`（例外集合）：

```javascript
let ratioSwapSet = new Set();
```

**基础归属**：由 `ratioSplit` 决定（前N个是A，后面是B）

**实际归属**：如果格子在 `ratioSwapSet` 中，就翻转

```javascript
const baseInA = aSet.has(key);                    // 基础：A还是B
const inA = ratioSwapSet.has(key) ? !baseInA : baseInA;  // 实际：翻转后的结果
```

**点击格子时**：把它加入/移出 `ratioSwapSet`：

```javascript
function toggleCellRatio(gx, gy) {
  const key = `${gx},${gy}`;
  if (ratioSwapSet.has(key)) {
    ratioSwapSet.delete(key);  // 再次点击 → 恢复原归属
  } else {
    ratioSwapSet.add(key);     // 第一次点击 → 翻转归属
  }
}
```

**统计时**：需要重新计算实际A区格数：

```javascript
let aCount = ratioSplit;
ratioSwapSet.forEach(key => {
  if (baseASet.has(key)) aCount--;  // 基础A → 被切到B
  else aCount++;                     // 基础B → 被切到A
});
```

### 防抖：拖拽时不要重复翻转

鼠标在同一个格子上滑动时，会触发多次 `mousemove`，每次都翻转 → 颜色疯狂跳动。

**解决**：用 `dragVisited` Set 记录本次拖拽已处理过的格子：

```javascript
let dragVisited = new Set();

function handleGridStart(dx, dy) {
  dragVisited.clear();        // 新的拖拽开始，清空记录
  dragVisited.add(key);
  // ...翻转格子
}

function handleGridMove(dx, dy) {
  if (dragVisited.has(key)) return;  // 同一格不重复处理
  dragVisited.add(key);
  // ...翻转格子
}
```

---

## 十、踩过的坑

### 坑1：坐标漂移（"大陆板块漂移"）

**现象**：描边完成后，格子整体向右偏移，与底图错开。按F12恢复。

**根因**：描边完成后右侧弹出 `ratio-panel`（200px），`map-area` 宽度缩水。图片因 CSS `width:100%` 自适应了，但 canvas 的 drawing buffer 没更新（`resize()` 没被触发）。

**修复**：面板出现后，用双重 `requestAnimationFrame` 等浏览器完成布局再调 `resize()`：

```javascript
ratioPanel.style.display = 'flex';
requestAnimationFrame(() => { requestAnimationFrame(resize); });
```

### 坑2：手机无法滚动

**现象**：手机浏览器打开后页面无法上下滚动。

**根因**：`body { touch-action: none }` 禁止了所有触摸手势，加上 canvas 拦截了 `touchstart`。

**修复**：canvas 默认 `pointer-events: none`，只在描边/选格时才设为 `auto`。用 `passive: false + preventDefault()` 精确控制，只在操作时阻止滚动。

### 坑3：getBoundingClientRect 浮点数

**现象**：越往下，鼠标位置和定点越偏。

**根因**：`getBoundingClientRect()` 返回浮点数，但 `canvas.width` 截断为整数，导致坐标映射有微小偏差，越往下累积越大。

**修复**：用 `offsetWidth/offsetHeight`（整数）代替 `getBoundingClientRect` 设置 canvas 尺寸。

### 坑4：闭合线缺失

**现象**：描边完成后，连接最后一个点和起点的线没画出来。

**根因**：`redrawTrace()` 画完所有线段后没有 `closePath()`。

**修复**：闭合后加 `traceCtx.closePath()`。

### 坑5：拖拽时颜色反复跳动

**现象**：在比例模式下，按住鼠标在格子上拖动，颜色反复闪烁。

**根因**：`mousemove` 在同一格内触发多次，每次都执行翻转逻辑。

**修复**：`dragVisited` Set 记录已处理的格子，同一次拖拽中不重复处理。

---

## 十一、设计决策回顾

| 决策 | 选择 | 理由 |
|------|------|------|
| 坐标存储 | 图片坐标 | 不同屏幕尺寸下数据一致 |
| 格子判断 | 中心点法 | 简单、够用、可扩展 |
| 格子大小 | 20px | 精度与操作的平衡点 |
| 分层架构 | img + 2个canvas | 互不干扰，各管各的重绘 |
| 面积计算 | 总面积÷总格数 | 不需要比例尺，只用相对占比 |
| 比例分配 | 行优先扫描 | 符合人的视觉直觉 |
| 手动微调 | ratioSwapSet例外集合 | 不破坏自动分配的基础逻辑 |
| 防抖 | dragVisited Set | 拖拽时同一格只处理一次 |

---

## 总结

这个工具的核心其实就三件事：

1. **描边**：点击 → 记录图片坐标 → 闭合 → 生成多边形
2. **网格**：包围盒遍历 → 中心点判断 → 画格子
3. **计算**：总格数 → 单格面积 → 选中格数 × 单格面积

所有复杂度都来自工程细节：坐标转换、布局响应、触摸适配、交互防抖。

算法本身不难（射线法 + 中心点判断），难的是把这些算法正确地组装到一个能在手机上流畅运行的单文件HTML里。
