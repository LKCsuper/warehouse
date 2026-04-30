import { useEffect, useRef, useState } from 'react';
import {
  closestCenter,
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';
import { open } from '@tauri-apps/api/dialog';
import { createDir, readTextFile, writeTextFile } from '@tauri-apps/api/fs';
import { appDataDir, join } from '@tauri-apps/api/path';

interface Material {
  id: number;
  name: string;
  model: string;
  category: string;
  package: string;
  parameters: string;
  supplier: string;
  purchase_url: string;
  datasheet_url: string;
  photo_url: string;
  project: string;
  description: string;
  quantity: number;
  low_stock_threshold: number;
  location: string;
  created_at: string;
  updated_at: string;
}

interface OperationLog {
  id: number;
  material_id: number;
  material_name: string;
  action: string;
  detail: string;
  created_at: string;
}

interface AppSnapshot {
  version: number;
  saved_at: string;
  materials: Material[];
  categories: string[];
  locations: string[];
  projects: string[];
  operation_logs: OperationLog[];
}

const IS_TAURI =
  typeof window !== 'undefined' &&
  typeof (window as Window & { __TAURI_IPC__?: unknown }).__TAURI_IPC__ !== 'undefined';

const STORAGE_KEYS = {
  materials: 'materials',
  categories: 'categories',
  locations: 'locations',
  projects: 'projects',
  operationLogs: 'operation_logs',
  backupDir: 'backup_dir',
  supabaseUrl: 'supabase_url',
  supabaseKey: 'supabase_key',
  viewMode: 'view_mode',
  theme: 'theme',
  snapshotSavedAt: 'snapshot_saved_at',
  previousSnapshot: 'previous_snapshot',
} as const;

const BACKUP_FOLDER = 'backups';
const BACKUP_JSON_FILE = 'warehouse-backup.json';
const BACKUP_XLS_FILE = 'warehouse-backup.xls';
const MATERIAL_IMAGE_BUCKET = 'warehouse-material-images';
const ENV_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim() || '';
const ENV_SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || '';
const CLOUD_SETUP_SQL = `create table if not exists warehouse_backups (
  id uuid primary key references auth.users(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot jsonb not null,
  updated_at timestamptz not null
);

alter table warehouse_backups enable row level security;

alter publication supabase_realtime add table warehouse_backups;

drop policy if exists "Users can read own backup" on warehouse_backups;
drop policy if exists "Users can create own backup" on warehouse_backups;
drop policy if exists "Users can update own backup" on warehouse_backups;

create policy "Users can read own backup"
on warehouse_backups for select
using (auth.uid() = user_id);

create policy "Users can create own backup"
on warehouse_backups for insert
with check (auth.uid() = user_id and auth.uid() = id);

create policy "Users can update own backup"
on warehouse_backups for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id and auth.uid() = id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'warehouse-material-images',
  'warehouse-material-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set public = true,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

drop policy if exists "Anyone can read material images" on storage.objects;
drop policy if exists "Users can upload own material images" on storage.objects;
drop policy if exists "Users can update own material images" on storage.objects;
drop policy if exists "Users can delete own material images" on storage.objects;

create policy "Anyone can read material images"
on storage.objects for select
using (bucket_id = 'warehouse-material-images');

create policy "Users can upload own material images"
on storage.objects for insert
with check (bucket_id = 'warehouse-material-images' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Users can update own material images"
on storage.objects for update
using (bucket_id = 'warehouse-material-images' and auth.uid()::text = (storage.foldername(name))[1])
with check (bucket_id = 'warehouse-material-images' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Users can delete own material images"
on storage.objects for delete
using (bucket_id = 'warehouse-material-images' and auth.uid()::text = (storage.foldername(name))[1]);`;

const DEFAULT_CATEGORIES = ['电阻', '电容', '电感', '二极管', '三极管', '芯片', '传感器', '连接器', '晶振', '其他'];
const DEFAULT_LOCATIONS = ['抽屉 A-1', '抽屉 A-2', '抽屉 B-1', '抽屉 B-2', '盒子 C-1', '盒子 C-2', '架子 D', '其他'];
const DEFAULT_PROJECTS: string[] = [];

let supabase: SupabaseClient | null = null;
let supabaseClientKey = '';

function getSupabaseConfig() {
  const url = ENV_SUPABASE_URL || localStorage.getItem(STORAGE_KEYS.supabaseUrl)?.trim() || '';
  const key = ENV_SUPABASE_KEY || localStorage.getItem(STORAGE_KEYS.supabaseKey)?.trim() || '';
  return { url, key, isConfigured: Boolean(url && key), isEnvConfigured: Boolean(ENV_SUPABASE_URL && ENV_SUPABASE_KEY) };
}

function initSupabase() {
  const { url, key, isConfigured } = getSupabaseConfig();
  if (!isConfigured) return null;

  const nextClientKey = `${url}:${key}`;
  if (!supabase || supabaseClientKey !== nextClientKey) {
    supabase = createClient(url, key);
    supabaseClientKey = nextClientKey;
  }

  return supabase;
}

function loadStoredList(key: string, defaults: string[]) {
  const saved = localStorage.getItem(key);
  if (!saved) return defaults;

  try {
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : defaults;
  } catch {
    return defaults;
  }
}

function loadStoredOperationLogs() {
  const saved = localStorage.getItem(STORAGE_KEYS.operationLogs);
  if (!saved) return [];

  try {
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is OperationLog => {
            return (
              typeof item === 'object' &&
              item !== null &&
              typeof item.id === 'number' &&
              typeof item.material_id === 'number' &&
              typeof item.material_name === 'string' &&
              typeof item.action === 'string' &&
              typeof item.detail === 'string' &&
              typeof item.created_at === 'string'
            );
          })
          .slice(0, 80)
      : [];
  } catch {
    return [];
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeMaterial(value: Partial<Material>, index = 0): Material {
  const now = new Date().toISOString();

  return {
    id: typeof value.id === 'number' ? value.id : Date.now() + index,
    name: typeof value.name === 'string' ? value.name.trim() : '',
    model: typeof value.model === 'string' ? value.model : '',
    category: typeof value.category === 'string' && value.category.trim() ? value.category : '其他',
    package: typeof value.package === 'string' ? value.package : '',
    parameters: typeof value.parameters === 'string' ? value.parameters : '',
    supplier: typeof value.supplier === 'string' ? value.supplier : '',
    purchase_url: typeof value.purchase_url === 'string' ? value.purchase_url : '',
    datasheet_url: typeof value.datasheet_url === 'string' ? value.datasheet_url : '',
    photo_url: typeof value.photo_url === 'string' ? value.photo_url : '',
    project: typeof value.project === 'string' ? value.project : '',
    description: typeof value.description === 'string' ? value.description : '',
    quantity:
      typeof value.quantity === 'number'
        ? Math.max(0, value.quantity)
        : Math.max(0, Number.parseInt(String(value.quantity ?? 0), 10) || 0),
    low_stock_threshold:
      typeof value.low_stock_threshold === 'number'
        ? Math.max(0, value.low_stock_threshold)
        : Math.max(0, Number.parseInt(String(value.low_stock_threshold ?? 0), 10) || 0),
    location: typeof value.location === 'string' ? value.location : '',
    created_at: typeof value.created_at === 'string' ? value.created_at : now,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : now,
  };
}

function createSnapshot(
  materials: Material[],
  categories: string[],
  locations: string[],
  operationLogs = loadStoredOperationLogs(),
  projects = loadStoredList(STORAGE_KEYS.projects, DEFAULT_PROJECTS),
): AppSnapshot {
  const normalizedMaterials = materials.map((item, index) => normalizeMaterial(item, index));
  const materialProjects = normalizedMaterials.map((item) => item.project).filter(Boolean);

  return {
    version: 1,
    saved_at: new Date().toISOString(),
    materials: normalizedMaterials,
    categories,
    locations,
    projects: Array.from(new Set([...projects, ...materialProjects])),
    operation_logs: operationLogs.slice(0, 80),
  };
}

function isValidDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function withSnapshotSavedAt(snapshot: AppSnapshot, savedAt: unknown): AppSnapshot {
  return isValidDateString(savedAt) ? { ...snapshot, saved_at: savedAt } : snapshot;
}

function getLatestMaterialTime(materials: Material[]) {
  return materials.reduce((latest, item) => {
    const updatedAtTime = new Date(item.updated_at).getTime();
    return Number.isNaN(updatedAtTime) ? latest : Math.max(latest, updatedAtTime);
  }, 0);
}

function getSnapshotTime(snapshot: AppSnapshot) {
  const savedAtTime = new Date(snapshot.saved_at).getTime();
  if (!Number.isNaN(savedAtTime)) return savedAtTime;

  return getLatestMaterialTime(snapshot.materials);
}

function reorderItems<T>(items: T[], fromIndex: number, toIndex: number) {
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return items;

  const nextItems = [...items];
  const [moved] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, moved);
  return nextItems;
}

function applyStoredMaterialOrder(remoteMaterials: Material[], localMaterials: Material[]) {
  if (localMaterials.length === 0) return remoteMaterials;

  const orderMap = new Map(localMaterials.map((item, index) => [item.id, index]));

  return [...remoteMaterials].sort((a, b) => {
    const indexA = orderMap.get(a.id);
    const indexB = orderMap.get(b.id);

    if (typeof indexA === 'number' && typeof indexB === 'number') return indexA - indexB;
    if (typeof indexA === 'number') return -1;
    if (typeof indexB === 'number') return 1;

    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
}

function haveSameMaterials(a: Material[], b: Material[]) {
  if (a.length !== b.length) return false;

  const bById = new Map(b.map((item) => [item.id, item]));
  return a.every((item) => {
    const other = bById.get(item.id);
    return Boolean(other) && JSON.stringify(item) === JSON.stringify(other);
  });
}

function isMissingTableError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '42P01'
  );
}

function saveSnapshotToLocalStorage(snapshot: AppSnapshot) {
  localStorage.setItem(STORAGE_KEYS.materials, JSON.stringify(snapshot.materials));
  localStorage.setItem(STORAGE_KEYS.categories, JSON.stringify(snapshot.categories));
  localStorage.setItem(STORAGE_KEYS.locations, JSON.stringify(snapshot.locations));
  localStorage.setItem(STORAGE_KEYS.projects, JSON.stringify(snapshot.projects));
  localStorage.setItem(STORAGE_KEYS.operationLogs, JSON.stringify(snapshot.operation_logs));
  localStorage.setItem(STORAGE_KEYS.snapshotSavedAt, snapshot.saved_at);
}

function savePreviousSnapshotIfNeeded(nextSnapshot: AppSnapshot) {
  const previousSnapshot = readSnapshotFromLocalStorage();
  const materialsChanged = !haveSameMaterials(previousSnapshot.materials, nextSnapshot.materials);
  const categoriesChanged = JSON.stringify(previousSnapshot.categories) !== JSON.stringify(nextSnapshot.categories);
  const locationsChanged = JSON.stringify(previousSnapshot.locations) !== JSON.stringify(nextSnapshot.locations);
  const projectsChanged = JSON.stringify(previousSnapshot.projects) !== JSON.stringify(nextSnapshot.projects);

  if (
    previousSnapshot.materials.length > 0 &&
    (materialsChanged || categoriesChanged || locationsChanged || projectsChanged)
  ) {
    localStorage.setItem(STORAGE_KEYS.previousSnapshot, JSON.stringify(previousSnapshot));
  }
}

function readSnapshotFromLocalStorage() {
  const rawMaterials = localStorage.getItem(STORAGE_KEYS.materials);
  let materials: Material[] = [];

  if (rawMaterials) {
    try {
      const parsed = JSON.parse(rawMaterials);
      if (Array.isArray(parsed)) {
        materials = parsed.map((item, index) => normalizeMaterial(item, index));
      }
    } catch {
      materials = [];
    }
  }

  const snapshot = createSnapshot(
    materials,
    loadStoredList(STORAGE_KEYS.categories, DEFAULT_CATEGORIES),
    loadStoredList(STORAGE_KEYS.locations, DEFAULT_LOCATIONS),
    loadStoredOperationLogs(),
    loadStoredList(STORAGE_KEYS.projects, DEFAULT_PROJECTS),
  );

  const savedAt = localStorage.getItem(STORAGE_KEYS.snapshotSavedAt);
  if (savedAt) return withSnapshotSavedAt(snapshot, savedAt);

  const latestMaterialTime = getLatestMaterialTime(materials);
  return withSnapshotSavedAt(
    snapshot,
    latestMaterialTime > 0 ? new Date(latestMaterialTime).toISOString() : new Date(0).toISOString(),
  );
}

function readPreviousSnapshotFromLocalStorage() {
  const saved = localStorage.getItem(STORAGE_KEYS.previousSnapshot);
  if (!saved) return null;

  try {
    return parseSnapshotPayload(JSON.parse(saved));
  } catch {
    return null;
  }
}

function buildExcelHtml(snapshot: AppSnapshot) {
  const rows = snapshot.materials
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.name)}</td>
          <td>${escapeHtml(item.model)}</td>
          <td>${escapeHtml(item.category)}</td>
          <td>${escapeHtml(item.package)}</td>
          <td>${escapeHtml(item.parameters)}</td>
          <td>${escapeHtml(item.supplier)}</td>
          <td>${escapeHtml(item.purchase_url)}</td>
          <td>${escapeHtml(item.datasheet_url)}</td>
          <td>${escapeHtml(item.photo_url)}</td>
          <td>${escapeHtml(item.project)}</td>
          <td>${item.quantity}</td>
          <td>${item.low_stock_threshold}</td>
          <td>${escapeHtml(item.location)}</td>
          <td>${escapeHtml(item.description)}</td>
          <td>${escapeHtml(item.created_at)}</td>
          <td>${escapeHtml(item.updated_at)}</td>
        </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Type" content="application/vnd.ms-excel; charset=UTF-8" />
  <title>物料仓库备份</title>
  <style>
    body { font-family: "Microsoft YaHei", Arial, sans-serif; padding: 20px; }
    h1, p { margin: 0 0 12px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #cbd5e1; padding: 8px 10px; text-align: left; }
    th { background: #e2e8f0; }
  </style>
</head>
<body>
  <h1>物料仓库备份</h1>
  <p>导出时间：${escapeHtml(snapshot.saved_at)}</p>
  <table>
    <thead>
      <tr>
        <th>名称</th>
        <th>型号</th>
        <th>分类</th>
        <th>封装</th>
        <th>参数</th>
        <th>供应商</th>
        <th>购买链接</th>
        <th>规格书</th>
        <th>图片</th>
        <th>项目</th>
        <th>数量</th>
        <th>预警值</th>
        <th>位置</th>
        <th>备注</th>
        <th>创建时间</th>
        <th>更新时间</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <script id="warehouse-backup" type="application/json">${JSON.stringify(snapshot)}</script>
</body>
</html>`;
}

async function getBackupPaths() {
  const customFolder = localStorage.getItem(STORAGE_KEYS.backupDir);
  const root = customFolder || (await appDataDir());
  const folder = customFolder || (await join(root, BACKUP_FOLDER));

  return {
    folder,
    jsonPath: await join(folder, BACKUP_JSON_FILE),
    xlsPath: await join(folder, BACKUP_XLS_FILE),
  };
}

async function writeLocalBackup(snapshot: AppSnapshot) {
  if (!IS_TAURI) return null;

  const paths = await getBackupPaths();
  await createDir(paths.folder, { recursive: true });
  await writeTextFile(paths.jsonPath, JSON.stringify(snapshot, null, 2));
  await writeTextFile(paths.xlsPath, buildExcelHtml(snapshot));
  return paths.xlsPath;
}

function parseSnapshotPayload(payload: unknown): AppSnapshot | null {
  if (Array.isArray(payload)) {
    return createSnapshot(
      payload.map((item, index) => normalizeMaterial(item as Partial<Material>, index)),
      DEFAULT_CATEGORIES,
      DEFAULT_LOCATIONS,
    );
  }

  if (!payload || typeof payload !== 'object') return null;

  const record = payload as Partial<AppSnapshot>;
  if (!Array.isArray(record.materials)) return null;

  const categories =
    Array.isArray(record.categories) && record.categories.length > 0
      ? record.categories.filter((item): item is string => typeof item === 'string')
      : Array.from(new Set(record.materials.map((item) => item.category || '').filter(Boolean)));

  const locations =
    Array.isArray(record.locations) && record.locations.length > 0
      ? record.locations.filter((item): item is string => typeof item === 'string')
      : Array.from(new Set(record.materials.map((item) => item.location || '').filter(Boolean)));

  const projects =
    Array.isArray(record.projects) && record.projects.length > 0
      ? record.projects.filter((item): item is string => typeof item === 'string')
      : Array.from(new Set(record.materials.map((item) => item.project || '').filter(Boolean)));

  return createSnapshot(
    record.materials.map((item, index) => normalizeMaterial(item, index)),
    categories.length > 0 ? categories : DEFAULT_CATEGORIES,
    locations.length > 0 ? locations : DEFAULT_LOCATIONS,
    Array.isArray(record.operation_logs)
      ? record.operation_logs.filter((item): item is OperationLog => {
          return (
            typeof item === 'object' &&
            item !== null &&
            typeof item.id === 'number' &&
            typeof item.material_id === 'number' &&
            typeof item.material_name === 'string' &&
            typeof item.action === 'string' &&
            typeof item.detail === 'string' &&
            typeof item.created_at === 'string'
          );
        })
      : loadStoredOperationLogs(),
    projects,
  );
}

function parseHtmlTableBackup(text: string) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const embedded = doc.querySelector('#warehouse-backup');

  if (embedded?.textContent) {
    try {
      return parseSnapshotPayload(JSON.parse(embedded.textContent));
    } catch {
      return null;
    }
  }

  const rows = Array.from(doc.querySelectorAll('tbody tr'));
  if (rows.length === 0) return null;

  const materials = rows
    .map((row, index) => {
      const cells = Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent?.trim() ?? '');
      if (!cells[0]) return null;

      return normalizeMaterial(
        {
          id: Date.now() + index,
          name: cells[0],
          model: cells[1] || '',
          category: cells[2] || '其他',
          package: cells[3] || '',
          parameters: cells[4] || '',
          supplier: cells[5] || '',
          purchase_url: cells[6] || '',
          datasheet_url: cells[7] || '',
          photo_url: cells.length >= 15 ? cells[8] || '' : '',
          project: cells.length >= 16 ? cells[9] || '' : '',
          quantity: Number.parseInt(cells[cells.length >= 16 ? 10 : cells.length >= 15 ? 9 : 8] || '0', 10) || 0,
          low_stock_threshold: Number.parseInt(cells[cells.length >= 16 ? 11 : cells.length >= 15 ? 10 : 9] || '0', 10) || 0,
          location: cells[cells.length >= 16 ? 12 : cells.length >= 15 ? 11 : 10] || '',
          description: cells[cells.length >= 16 ? 13 : cells.length >= 15 ? 12 : 11] || '',
          created_at: cells[cells.length >= 16 ? 14 : cells.length >= 15 ? 13 : 12] || new Date().toISOString(),
          updated_at: cells[cells.length >= 16 ? 15 : cells.length >= 15 ? 14 : 13] || new Date().toISOString(),
        },
        index,
      );
    })
    .filter((item): item is Material => Boolean(item));

  return createSnapshot(
    materials,
    Array.from(new Set(materials.map((item) => item.category).filter(Boolean))),
    Array.from(new Set(materials.map((item) => item.location).filter(Boolean))),
  );
}

function parseImportedBackup(fileName: string, text: string) {
  if (fileName.toLowerCase().endsWith('.json')) {
    return parseSnapshotPayload(JSON.parse(text));
  }

  return parseHtmlTableBackup(text);
}

function downloadFile(content: string, fileName: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function getStockModalTitle(mode: 'in' | 'out' | 'set') {
  if (mode === 'in') return '入库';
  if (mode === 'out') return '出库';
  return '设置库存';
}

function isLowStock(item: Material) {
  return item.quantity > 0 && item.quantity <= item.low_stock_threshold;
}

function createOperationLog(material: Material, action: string, detail: string): OperationLog {
  return {
    id: Date.now(),
    material_id: material.id,
    material_name: material.name || '未命名物料',
    action,
    detail,
    created_at: new Date().toISOString(),
  };
}

function toSupabaseMaterial(material: Material) {
  const {
    low_stock_threshold: _lowStockThreshold,
    package: _package,
    parameters: _parameters,
    supplier: _supplier,
    purchase_url: _purchaseUrl,
    datasheet_url: _datasheetUrl,
    photo_url: _photoUrl,
    ...cloudMaterial
  } = material;
  return cloudMaterial;
}

function getImageExtension(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension && /^[a-z0-9]+$/.test(extension)) return extension;

  const mimeExtension = file.type.split('/')[1]?.toLowerCase();
  return mimeExtension || 'jpg';
}

function openExternalLink(url: string) {
  if (!url) return;
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  window.open(href, '_blank', 'noopener,noreferrer');
}

function isInteractiveElement(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('button, input, select, textarea, a, label'));
}

interface SortableSidebarItemProps {
  id: string;
  label: string;
  isActive?: boolean;
  deleteTitle: string;
  onClick?: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function SortableSidebarItem({
  id,
  label,
  isActive = false,
  deleteTitle,
  onClick,
  onRename,
  onDelete,
}: SortableSidebarItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
      onClick={onClick}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onRename();
      }}
    >
      <button
        type="button"
        className="drag-handle"
        title="拖动排序"
        aria-label={`拖动排序：${label}`}
        onClick={(event) => event.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <span>{label}</span>
      <button
        type="button"
        className="delete-btn force-show"
        title={deleteTitle}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        ×
      </button>
    </li>
  );
}

function App() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [categories, setCategories] = useState<string[]>(() =>
    loadStoredList(STORAGE_KEYS.categories, DEFAULT_CATEGORIES),
  );
  const [locations, setLocations] = useState<string[]>(() =>
    loadStoredList(STORAGE_KEYS.locations, DEFAULT_LOCATIONS),
  );
  const [projects, setProjects] = useState<string[]>(() =>
    loadStoredList(STORAGE_KEYS.projects, DEFAULT_PROJECTS),
  );
  const [operationLogs, setOperationLogs] = useState<OperationLog[]>(() => loadStoredOperationLogs());
  const [selectedCategory, setSelectedCategory] = useState('全部');
  const [quickFilter, setQuickFilter] = useState<
    'all' | 'attention' | 'empty' | 'unset-location' | 'missing-image' | 'missing-datasheet' | 'missing-purchase'
  >('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState<Material | null>(null);
  const [isOnline, setIsOnline] = useState(() => getSupabaseConfig().isConfigured);
  const [isLoading, setIsLoading] = useState(true);
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [isLocationModalOpen, setIsLocationModalOpen] = useState(false);
  const [newLocationName, setNewLocationName] = useState('');
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [isCategorySectionOpen, setIsCategorySectionOpen] = useState(true);
  const [isLocationSectionOpen, setIsLocationSectionOpen] = useState(true);
  const [backupMessage, setBackupMessage] = useState('本地备份待创建');
  const [backupPath, setBackupPath] = useState('');
  const [backupDir, setBackupDir] = useState(() => localStorage.getItem(STORAGE_KEYS.backupDir) || '');
  const [cloudMessage, setCloudMessage] = useState(() =>
    getSupabaseConfig().isConfigured ? '云端备份已配置' : '未配置云端备份',
  );
  const [isCloudModalOpen, setIsCloudModalOpen] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [cloudUser, setCloudUser] = useState<User | null>(null);
  const [cloudCheckMessage, setCloudCheckMessage] = useState('');
  const [isCheckingCloud, setIsCheckingCloud] = useState(false);
  const [viewMode, setViewMode] = useState<'card' | 'table'>(() =>
    localStorage.getItem(STORAGE_KEYS.viewMode) === 'table' ? 'table' : 'card',
  );
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem(STORAGE_KEYS.theme) === 'dark' ? 'dark' : 'light',
  );
  const [cloudForm, setCloudForm] = useState(() => {
    const config = getSupabaseConfig();
    return { url: config.url, key: config.key };
  });
  const [authForm, setAuthForm] = useState({ email: '', password: '' });
  const [stockModal, setStockModal] = useState<{
    material: Material;
    mode: 'in' | 'out' | 'set';
    quantity: number;
  } | null>(null);
  const [detailMaterialId, setDetailMaterialId] = useState<number | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState('');
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const sortableSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const [formData, setFormData] = useState({
    name: '',
    model: '',
    category: '其他',
    package: '',
    parameters: '',
    supplier: '',
    purchase_url: '',
    datasheet_url: '',
    photo_url: '',
    project: '',
    description: '',
    quantity: 0,
    low_stock_threshold: 0,
    location: '',
  });
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState('');
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const realtimeChannelRef = useRef<ReturnType<SupabaseClient['channel']> | null>(null);
  const realtimeRefreshTimerRef = useRef<number | null>(null);
  const cloudPollingTimerRef = useRef<number | null>(null);

  async function syncLatestCloudState(sourceLabel = '云端') {
    const cloud = initSupabase();
    if (!cloud) {
      setIsOnline(false);
      return false;
    }

    const localSnapshot = readSnapshotFromLocalStorage();
    const { data: userData } = await cloud.auth.getUser();
    const user = userData.user;

    if (user) {
      const { data: backupData, error: backupError } = await cloud
        .from('warehouse_backups')
        .select('snapshot, updated_at')
        .eq('id', user.id)
        .maybeSingle();

      if (backupError) throw backupError;

      const cloudSnapshot = parseSnapshotPayload(backupData?.snapshot);
      const cloudSavedAt = backupData?.updated_at ?? cloudSnapshot?.saved_at;
      const cloudSnapshotWithTime = cloudSnapshot ? withSnapshotSavedAt(cloudSnapshot, cloudSavedAt) : null;

      if (cloudSnapshotWithTime && getSnapshotTime(cloudSnapshotWithTime) > getSnapshotTime(localSnapshot)) {
        if (cloudSnapshotWithTime.materials.length === 0 && localSnapshot.materials.length > 0) {
          setIsOnline(true);
          setCloudMessage('云端备份为空，已保留本机物料，未自动覆盖');
          return false;
        }

        await persistSnapshot(cloudSnapshotWithTime);
        const message = `已自动同步${sourceLabel}：${new Date(cloudSnapshotWithTime.saved_at).toLocaleString()}`;
        setBackupMessage(message);
        setCloudMessage(message);
        setIsOnline(true);
        return true;
      }
    }

    const { data, error } = await cloud
      .from('materials')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) {
      if (isMissingTableError(error)) {
        setIsOnline(true);
        return false;
      }
      throw error;
    }
    if (!data) return false;

    const orderedMaterials = applyStoredMaterialOrder(
      data.map((item, index) => normalizeMaterial(item, index)),
      localSnapshot.materials,
    );

    if (orderedMaterials.length === 0 && localSnapshot.materials.length > 0) {
      setIsOnline(true);
      setCloudMessage('云端物料为空，已保留本机物料，未自动覆盖');
      return false;
    }

    if (haveSameMaterials(orderedMaterials, localSnapshot.materials)) {
      setIsOnline(true);
      return false;
    }

    await persistSnapshot(
      createSnapshot(
        orderedMaterials,
        localSnapshot.categories,
        localSnapshot.locations,
        localSnapshot.operation_logs,
        localSnapshot.projects,
      ),
    );
    setCloudMessage(`已自动同步${sourceLabel}物料：${new Date().toLocaleString()}`);
    setIsOnline(true);
    return true;
  }

  function scheduleCloudRefresh(sourceLabel = '云端') {
    if (realtimeRefreshTimerRef.current !== null) {
      window.clearTimeout(realtimeRefreshTimerRef.current);
    }

    realtimeRefreshTimerRef.current = window.setTimeout(() => {
      realtimeRefreshTimerRef.current = null;
      void syncLatestCloudState(sourceLabel).catch((error) => {
        console.error('实时同步云端数据失败:', error);
        setIsOnline(false);
        setCloudMessage('实时同步失败，请检查网络或 Supabase Realtime 配置');
      });
    }, 300);
  }

  function stopRealtimeSync() {
    if (realtimeRefreshTimerRef.current !== null) {
      window.clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = null;
    }
    if (cloudPollingTimerRef.current !== null) {
      window.clearInterval(cloudPollingTimerRef.current);
      cloudPollingTimerRef.current = null;
    }

    const cloud = initSupabase();
    if (cloud && realtimeChannelRef.current) {
      void cloud.removeChannel(realtimeChannelRef.current);
    }
    realtimeChannelRef.current = null;
  }

  function startRealtimeSync(userId?: string) {
    const cloud = initSupabase();
    if (!cloud) return;

    stopRealtimeSync();

    const channel = cloud
      .channel(`warehouse-sync-${userId ?? 'public'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'materials' }, () => {
        scheduleCloudRefresh('其他设备');
      });

    if (userId) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'warehouse_backups', filter: `user_id=eq.${userId}` },
        () => {
          scheduleCloudRefresh('其他设备');
        },
      );
    }

    realtimeChannelRef.current = channel;
    void channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setIsOnline(true);
      }
    });

    cloudPollingTimerRef.current = window.setInterval(() => {
      void syncLatestCloudState('云端').catch((error) => {
        console.error('定时同步云端数据失败:', error);
      });
    }, 10000);
  }

  async function uploadCloudSnapshot(snapshot: AppSnapshot, showAlert = false) {
    const cloud = initSupabase();
    if (!cloud) {
      if (showAlert) setIsCloudModalOpen(true);
      return false;
    }

    const { data } = await cloud.auth.getUser();
    const user = data.user;
    if (!user) {
      if (showAlert) openAuthModal();
      return false;
    }

    const { error } = await cloud.from('warehouse_backups').upsert({
      id: user.id,
      user_id: user.id,
      snapshot,
      updated_at: snapshot.saved_at,
    });

    if (error) throw error;

    setCloudUser(user);
    setCloudMessage(`云端备份已更新 ${new Date(snapshot.saved_at).toLocaleString()}`);
    setIsOnline(true);
    return true;
  }

  async function persistSnapshot(snapshot: AppSnapshot, syncState = true) {
    savePreviousSnapshotIfNeeded(snapshot);
    saveSnapshotToLocalStorage(snapshot);

    if (syncState) {
      setMaterials(snapshot.materials);
      setCategories(snapshot.categories);
      setLocations(snapshot.locations);
      setProjects(snapshot.projects);
      setOperationLogs(snapshot.operation_logs);
    }

    try {
      const path = await writeLocalBackup(snapshot);
      if (path) {
        setBackupPath(path);
        setBackupMessage(`已自动备份 ${new Date(snapshot.saved_at).toLocaleString()}`);
      } else {
        setBackupMessage('当前是浏览器预览模式，只保留本地缓存');
      }
    } catch (error) {
      console.error('写入本地备份失败:', error);
      setBackupMessage('本地备份写入失败，但缓存仍已保存');
    }

    try {
      await uploadCloudSnapshot(snapshot, false);
    } catch (error) {
      console.error('自动上传云端备份失败:', error);
      setIsOnline(false);
      setCloudMessage('自动云端备份失败，请检查网络或权限');
    }
  }

  async function restoreBackupIfNeeded() {
    const hasLocalMaterials = Boolean(localStorage.getItem(STORAGE_KEYS.materials));
    if (hasLocalMaterials || !IS_TAURI) return null;

    try {
      const paths = await getBackupPaths();
      const text = await readTextFile(paths.jsonPath);
      const snapshot = parseSnapshotPayload(JSON.parse(text));
      if (!snapshot) return null;

      saveSnapshotToLocalStorage(snapshot);
      setBackupPath(paths.xlsPath);
      setBackupMessage('已从本地备份恢复数据');
      return snapshot;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    void loadMaterials();
    void refreshCloudUser().then((user) => {
      if (user) startRealtimeSync(user.id);
    });

    const cloud = initSupabase();
    const subscription = cloud?.auth.onAuthStateChange((_event, session) => {
      setCloudUser(session?.user ?? null);
      setCloudMessage(session?.user?.email ? `已登录：${session.user.email}` : '云端备份已配置，请登录后同步');
      if (session?.user) {
        startRealtimeSync(session.user.id);
        scheduleCloudRefresh('云端');
      } else {
        stopRealtimeSync();
      }
    });

    return () => {
      stopRealtimeSync();
      subscription?.data.subscription.unsubscribe();
    };
  }, []);

  async function refreshCloudUser() {
    const cloud = initSupabase();
    if (!cloud) return null;

    const { data } = await cloud.auth.getUser();
    const user = data.user ?? null;
    setCloudUser(user);
    if (user?.email) {
      setCloudMessage(`已登录：${user.email}`);
    }
    return user;
  }

  async function loadMaterials() {
    try {
      const restored = await restoreBackupIfNeeded();
      const localSnapshot = restored ?? readSnapshotFromLocalStorage();
      setMaterials(localSnapshot.materials);
      setCategories(localSnapshot.categories);
      setLocations(localSnapshot.locations);
      setProjects(localSnapshot.projects);
      setOperationLogs(localSnapshot.operation_logs);

      if (IS_TAURI) {
        try {
          const paths = await getBackupPaths();
          setBackupPath(paths.xlsPath);
          setBackupMessage(localSnapshot.materials.length > 0 ? '已加载本地数据' : '本地备份待创建');
        } catch {
          setBackupPath('');
        }
      } else {
        setBackupPath('浏览器预览模式不自动写入本地文件');
      }

      const cloud = initSupabase();
      if (!cloud) {
        setIsOnline(false);
        return;
      }

      await syncLatestCloudState('云端');
    } catch (error) {
      console.error('加载数据失败:', error);
      setIsOnline(false);
    } finally {
      setIsLoading(false);
    }
  }

  async function saveMaterial(material: Partial<Material>, actionLabel = '更新') {
    const now = new Date().toISOString();
    const isEditing = typeof material.id === 'number';
    const currentSnapshot = readSnapshotFromLocalStorage();
    let nextMaterials = [...currentSnapshot.materials];
    let nextLogs = currentSnapshot.operation_logs;
    let nextMaterial: Material;
    let shouldUpdateCloudMaterial = false;

    if (isEditing) {
      const index = nextMaterials.findIndex((item) => item.id === material.id);
      if (index >= 0) {
        shouldUpdateCloudMaterial = true;
        const previousMaterial = nextMaterials[index];
        nextMaterial = normalizeMaterial({ ...nextMaterials[index], ...material, updated_at: now }, index);
        nextMaterials[index] = nextMaterial;
        const details: string[] = [];
        if (previousMaterial.quantity !== nextMaterial.quantity) {
          details.push(`库存 ${previousMaterial.quantity} -> ${nextMaterial.quantity}`);
        }
        if (previousMaterial.category !== nextMaterial.category) {
          details.push(`分类 ${previousMaterial.category} -> ${nextMaterial.category}`);
        }
        if (previousMaterial.location !== nextMaterial.location) {
          details.push(`位置 ${previousMaterial.location || '未设置'} -> ${nextMaterial.location || '未设置'}`);
        }
        if (previousMaterial.project !== nextMaterial.project) {
          details.push(`项目 ${previousMaterial.project || '未设置'} -> ${nextMaterial.project || '未设置'}`);
        }
        if (previousMaterial.package !== nextMaterial.package) {
          details.push(`封装 ${previousMaterial.package || '未填'} -> ${nextMaterial.package || '未填'}`);
        }
        if (previousMaterial.parameters !== nextMaterial.parameters) {
          details.push('参数已更新');
        }
        if (previousMaterial.supplier !== nextMaterial.supplier) {
          details.push(`供应商 ${previousMaterial.supplier || '未填'} -> ${nextMaterial.supplier || '未填'}`);
        }
        if (previousMaterial.low_stock_threshold !== nextMaterial.low_stock_threshold) {
          details.push(`预警值 ${previousMaterial.low_stock_threshold} -> ${nextMaterial.low_stock_threshold}`);
        }
        if (previousMaterial.photo_url !== nextMaterial.photo_url) {
          details.push(nextMaterial.photo_url ? '图片已更新' : '图片已移除');
        }
        if (details.length > 0) {
          nextLogs = [createOperationLog(nextMaterial, actionLabel, details.join('，')), ...nextLogs].slice(0, 80);
        }
      } else {
        nextMaterial = normalizeMaterial({ ...material, created_at: now, updated_at: now }, nextMaterials.length);
        nextMaterials.unshift(nextMaterial);
        nextLogs = [createOperationLog(nextMaterial, '新增', '新增物料'), ...nextLogs].slice(0, 80);
      }
    } else {
      nextMaterial = normalizeMaterial(
        { ...material, id: Date.now(), created_at: now, updated_at: now },
        nextMaterials.length,
      );
      nextMaterials.unshift(nextMaterial);
      nextLogs = [createOperationLog(nextMaterial, '新增', '新增物料'), ...nextLogs].slice(0, 80);
    }

    await persistSnapshot(createSnapshot(nextMaterials, categories, locations, nextLogs, projects));

    const cloud = initSupabase();
    if (!cloud) {
      setIsOnline(false);
      return;
    }

    try {
      if (shouldUpdateCloudMaterial) {
        const { error } = await cloud
          .from('materials')
          .update({ ...toSupabaseMaterial(nextMaterial), updated_at: now })
          .eq('id', nextMaterial.id);
        if (error) throw error;
      } else {
        const { error } = await cloud.from('materials').insert([toSupabaseMaterial(nextMaterial)]);
        if (error) throw error;
      }

      setIsOnline(true);
    } catch (error) {
      console.error('同步到云端失败:', error);
      setIsOnline(false);
    }
  }

  async function uploadMaterialImage(file: File, materialId: number) {
    const cloud = initSupabase();
    if (!cloud) {
      setIsCloudModalOpen(true);
      throw new Error('请先配置 Supabase 云端备份，再上传器件图片。');
    }

    const { data } = await cloud.auth.getUser();
    const user = data.user;
    if (!user) {
      openAuthModal();
      throw new Error('请先登录云端账号，再上传器件图片。');
    }

    const path = `${user.id}/${materialId}/${Date.now()}.${getImageExtension(file)}`;
    const { error } = await cloud.storage.from(MATERIAL_IMAGE_BUCKET).upload(path, file, {
      cacheControl: '31536000',
      upsert: true,
    });

    if (error) throw error;

    const { data: publicUrlData } = cloud.storage.from(MATERIAL_IMAGE_BUCKET).getPublicUrl(path);
    return publicUrlData.publicUrl;
  }

  async function deleteMaterial(id: number) {
    if (!confirm('确定要删除这条物料吗？')) return;

    const currentSnapshot = readSnapshotFromLocalStorage();
    const deletedMaterial = currentSnapshot.materials.find((item) => item.id === id);
    const nextMaterials = currentSnapshot.materials.filter((item) => item.id !== id);
    const nextLogs = deletedMaterial
      ? [createOperationLog(deletedMaterial, '删除', '删除物料'), ...currentSnapshot.operation_logs].slice(0, 80)
      : currentSnapshot.operation_logs;
    await persistSnapshot(
      createSnapshot(nextMaterials, currentSnapshot.categories, currentSnapshot.locations, nextLogs, currentSnapshot.projects),
    );

    const cloud = initSupabase();
    if (!cloud) {
      setIsOnline(false);
      return;
    }

    try {
      const { error } = await cloud.from('materials').delete().eq('id', id);
      if (error) throw error;
      setIsOnline(true);
    } catch (error) {
      console.error('删除云端数据失败:', error);
      setIsOnline(false);
    }
  }

  async function updateQuantity(id: number, delta: number) {
    const material = materials.find((item) => item.id === id);
    if (!material) return;

    await saveMaterial({
      ...material,
      quantity: Math.max(0, material.quantity + delta),
    }, delta > 0 ? '入库' : '出库');
  }

  function updateViewMode(nextMode: 'card' | 'table') {
    setViewMode(nextMode);
    localStorage.setItem(STORAGE_KEYS.viewMode, nextMode);
  }

  function toggleTheme() {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem(STORAGE_KEYS.theme, nextTheme);
  }

  function openStockModal(material: Material, mode: 'in' | 'out' | 'set') {
    setStockModal({
      material,
      mode,
      quantity: mode === 'set' ? material.quantity : 1,
    });
  }

  async function handleStockSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!stockModal) return;

    const quantity = Math.max(0, Number(stockModal.quantity) || 0);
    const nextQuantity =
      stockModal.mode === 'in'
        ? stockModal.material.quantity + quantity
        : stockModal.mode === 'out'
          ? Math.max(0, stockModal.material.quantity - quantity)
          : quantity;

    await saveMaterial(
      {
        ...stockModal.material,
        quantity: nextQuantity,
      },
      stockModal.mode === 'in' ? '入库' : stockModal.mode === 'out' ? '出库' : '盘点',
    );
    setStockModal(null);
  }

  async function updateMaterialField<K extends keyof Material>(
    material: Material,
    field: K,
    value: Material[K],
  ) {
    await saveMaterial({
      ...material,
      [field]: value,
    });
  }

  async function saveCategories(nextCategories: string[]) {
    await persistSnapshot(createSnapshot(materials, nextCategories, locations, operationLogs, projects));
  }

  async function saveLocations(nextLocations: string[]) {
    await persistSnapshot(createSnapshot(materials, categories, nextLocations, operationLogs, projects));
  }

  async function saveProjects(nextProjects: string[]) {
    await persistSnapshot(createSnapshot(materials, categories, locations, operationLogs, nextProjects));
  }

  async function handleCategorySortEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const fromIndex = categories.indexOf(String(active.id));
    const toIndex = categories.indexOf(String(over.id));
    await saveCategories(reorderItems(categories, fromIndex, toIndex));
  }

  async function handleLocationSortEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const fromIndex = locations.indexOf(String(active.id));
    const toIndex = locations.indexOf(String(over.id));
    await saveLocations(reorderItems(locations, fromIndex, toIndex));
  }

  async function moveMaterialByStep(materialId: number, direction: 'up' | 'down') {
    const fromIndex = materials.findIndex((item) => item.id === materialId);
    const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
    await persistSnapshot(createSnapshot(reorderItems(materials, fromIndex, toIndex), categories, locations, operationLogs, projects));
  }

  async function handleCategoryDelete(category: string) {
    const count = materials.filter((item) => item.category === category).length;
    if (count > 0) {
      alert(`分类“${category}”下还有 ${count} 条器件，不能删除。请先调整或删除这些器件。`);
      return;
    }

    if (!confirm(`确定删除分类“${category}”吗？`)) return;
    await saveCategories(categories.filter((item) => item !== category));
  }

  async function handleCategoryRename(category: string) {
    const nextName = prompt('修改分类名称', category)?.trim();
    if (!nextName || nextName === category) return;
    if (categories.includes(nextName)) {
      alert('这个分类名称已经存在。');
      return;
    }

    const nextCategories = categories.map((item) => (item === category ? nextName : item));
    const nextMaterials = materials.map((item) =>
      item.category === category ? { ...item, category: nextName, updated_at: new Date().toISOString() } : item,
    );
    const nextLogs = [
      {
        id: Date.now(),
        material_id: 0,
        material_name: '分类管理',
        action: '重命名分类',
        detail: `${category} -> ${nextName}`,
        created_at: new Date().toISOString(),
      },
      ...operationLogs,
    ].slice(0, 80);

    await persistSnapshot(createSnapshot(nextMaterials, nextCategories, locations, nextLogs, projects));
  }

  async function handleLocationDelete(location: string) {
    const count = materials.filter((item) => item.location === location).length;
    if (count > 0) {
      alert(`位置“${location}”下还有 ${count} 条器件，不能删除。请先调整或删除这些器件。`);
      return;
    }

    if (!confirm(`确定删除位置“${location}”吗？`)) return;
    await saveLocations(locations.filter((item) => item !== location));
  }

  async function handleLocationRename(location: string) {
    const nextName = prompt('修改位置名称', location)?.trim();
    if (!nextName || nextName === location) return;
    if (locations.includes(nextName)) {
      alert('这个位置名称已经存在。');
      return;
    }

    const nextLocations = locations.map((item) => (item === location ? nextName : item));
    const nextMaterials = materials.map((item) =>
      item.location === location ? { ...item, location: nextName, updated_at: new Date().toISOString() } : item,
    );
    const nextLogs = [
      {
        id: Date.now(),
        material_id: 0,
        material_name: '位置管理',
        action: '重命名位置',
        detail: `${location} -> ${nextName}`,
        created_at: new Date().toISOString(),
      },
      ...operationLogs,
    ].slice(0, 80);

    await persistSnapshot(createSnapshot(nextMaterials, categories, nextLocations, nextLogs, projects));
  }

  function openAddModal() {
    setEditingMaterial(null);
    setImageFile(null);
    setImagePreviewUrl('');
    setFormData({
      name: '',
      model: '',
      category: categories[0] || '其他',
      package: '',
      parameters: '',
      supplier: '',
      purchase_url: '',
      datasheet_url: '',
      photo_url: '',
      project: '',
      description: '',
      quantity: 0,
      low_stock_threshold: 0,
      location: '',
    });
    setIsModalOpen(true);
  }

  function openEditModal(material: Material) {
    setEditingMaterial(material);
    setImageFile(null);
    setImagePreviewUrl(material.photo_url);
    setFormData({
      name: material.name,
      model: material.model,
      category: material.category,
      package: material.package,
      parameters: material.parameters,
      supplier: material.supplier,
      purchase_url: material.purchase_url,
      datasheet_url: material.datasheet_url,
      photo_url: material.photo_url,
      project: material.project,
      description: material.description,
      quantity: material.quantity,
      low_stock_threshold: material.low_stock_threshold,
      location: material.location,
    });
    setIsModalOpen(true);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const materialId = editingMaterial?.id ?? Date.now();

    try {
      setIsUploadingImage(true);
      const photoUrl = imageFile ? await uploadMaterialImage(imageFile, materialId) : formData.photo_url;
      await saveMaterial({
        ...formData,
        id: materialId,
        photo_url: photoUrl,
      });
      setImageFile(null);
      setImagePreviewUrl('');
      setIsModalOpen(false);
    } catch (error) {
      console.error('保存物料失败:', error);
      alert(error instanceof Error ? error.message : '保存失败，请稍后再试。');
    } finally {
      setIsUploadingImage(false);
    }
  }

  function handleImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('请选择图片文件。');
      event.target.value = '';
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      alert('图片不能超过 5MB。');
      event.target.value = '';
      return;
    }

    setImageFile(file);
    setImagePreviewUrl(URL.createObjectURL(file));
  }

  function handleExport() {
    const snapshot = createSnapshot(materials, categories, locations, operationLogs, projects);
    downloadFile(
      buildExcelHtml(snapshot),
      `warehouse-backup-${new Date().toISOString().slice(0, 10)}.xls`,
      'application/vnd.ms-excel;charset=utf-8',
    );
  }

  function handleImportClick() {
    importInputRef.current?.click();
  }

  function openAuthModal() {
    if (!getSupabaseConfig().isConfigured) {
      setCloudCheckMessage('请先完成云端设置：填写 Supabase URL 和 anon key，执行建表 SQL，再检查连接。');
      setIsCloudModalOpen(true);
      return;
    }

    setIsAuthModalOpen(true);
  }

  async function handleChooseBackupDir() {
    if (!IS_TAURI) {
      alert('只有桌面版才能选择备份目录。');
      return;
    }

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择备份目录',
      });

      if (!selected || Array.isArray(selected)) return;

      localStorage.setItem(STORAGE_KEYS.backupDir, selected);
      setBackupDir(selected);
      await persistSnapshot(createSnapshot(materials, categories, locations, operationLogs, projects), false);
      alert(`备份目录已更新为：${selected}`);
    } catch (error) {
      console.error('选择备份目录失败:', error);
      alert('选择备份目录失败，请稍后再试。');
    }
  }

  async function handleResetBackupDir() {
    localStorage.removeItem(STORAGE_KEYS.backupDir);
    setBackupDir('');
    await persistSnapshot(createSnapshot(materials, categories, locations, operationLogs, projects), false);
    alert('已恢复为默认备份目录。');
  }

  async function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const snapshot = parseImportedBackup(file.name, text);

      if (!snapshot) {
        alert('未识别到可导入的数据文件，请选择系统导出的 Excel 或 JSON 备份。');
        return;
      }

      await persistSnapshot(snapshot);
      setSelectedCategory('全部');
      alert(`导入成功，共恢复 ${snapshot.materials.length} 条物料。`);
    } catch (error) {
      console.error('导入失败:', error);
      alert('导入失败，请确认文件格式正确。');
    } finally {
      event.target.value = '';
    }
  }

  async function handleSaveCloudConfig(event: React.FormEvent) {
    event.preventDefault();

    const url = cloudForm.url.trim();
    const key = cloudForm.key.trim();
    if (!url || !key) {
      alert('请填写 Supabase URL 和 anon key。');
      return;
    }

    localStorage.setItem(STORAGE_KEYS.supabaseUrl, url);
    localStorage.setItem(STORAGE_KEYS.supabaseKey, key);
    supabase = null;
    supabaseClientKey = '';
    setCloudMessage('云端备份已配置，请登录后同步');
    setIsOnline(true);
    setIsCloudModalOpen(false);

    await refreshCloudUser();
    await loadMaterials();
  }

  async function handleCheckCloudConnection() {
    const url = cloudForm.url.trim();
    const key = cloudForm.key.trim();
    if (!url || !key) {
      setCloudCheckMessage('请先填写 Supabase URL 和 anon key。');
      return;
    }

    setIsCheckingCloud(true);
    setCloudCheckMessage('正在检查云端连接...');

    try {
      const testClient = createClient(url, key);
      const { data: sessionData, error: sessionError } = await testClient.auth.getSession();
      if (sessionError) throw sessionError;

      const { error: tableError } = await testClient
        .from('warehouse_backups')
        .select('id, updated_at')
        .limit(1);

      if (tableError) {
        setIsOnline(false);
        setCloudCheckMessage(`项目可连接，但备份表或权限不可用：${tableError.message}`);
        return;
      }

      const { error: storageError } = await testClient.storage.from(MATERIAL_IMAGE_BUCKET).list('', { limit: 1 });
      if (storageError) {
        setIsOnline(false);
        setCloudCheckMessage(`项目可连接，但图片存储桶或权限不可用：${storageError.message}`);
        return;
      }

      setIsOnline(true);
      setCloudCheckMessage(
        sessionData.session
          ? '检查通过：项目可连接，已登录账号，备份表和图片存储可访问。'
          : '检查通过：项目可连接，备份表和图片存储可访问。请登录账号后上传或恢复备份。',
      );
    } catch (error) {
      console.error('检查云端连接失败:', error);
      setIsOnline(false);
      setCloudCheckMessage(error instanceof Error ? `连接失败：${error.message}` : '连接失败，请检查 URL 和 anon key。');
    } finally {
      setIsCheckingCloud(false);
    }
  }

  async function handleCopyCloudSql() {
    try {
      await navigator.clipboard.writeText(CLOUD_SETUP_SQL);
      setCloudCheckMessage('建表 SQL 已复制，可以粘贴到 Supabase SQL Editor 执行。');
    } catch {
      setCloudCheckMessage('复制失败，请手动选中 SQL 内容复制。');
    }
  }

  function handleClearCloudConfig() {
    if (!confirm('确定清除云端配置吗？本机缓存不会删除。')) return;

    void supabase?.auth.signOut();
    localStorage.removeItem(STORAGE_KEYS.supabaseUrl);
    localStorage.removeItem(STORAGE_KEYS.supabaseKey);
    supabase = null;
    supabaseClientKey = '';
    setCloudUser(null);
    setCloudForm({ url: '', key: '' });
    setCloudMessage('未配置云端备份');
    setIsOnline(false);
    setIsCloudModalOpen(false);
  }

  async function handleCloudAuth(mode: 'sign-in' | 'sign-up') {
    const cloud = initSupabase();
    if (!cloud) {
      setIsCloudModalOpen(true);
      return;
    }

    const email = authForm.email.trim();
    const password = authForm.password;
    if (!email || password.length < 6) {
      alert('请输入邮箱和至少 6 位密码。');
      return;
    }

    try {
      const result =
        mode === 'sign-in'
          ? await cloud.auth.signInWithPassword({ email, password })
          : await cloud.auth.signUp({ email, password });

      if (result.error) throw result.error;

      const user = result.data.user ?? (await refreshCloudUser());
      if (user && 'email' in user) {
        setCloudUser(user as User);
      }

      setCloudMessage(mode === 'sign-in' ? `已登录：${email}` : `账号已创建：${email}`);
      setIsOnline(true);
      setIsAuthModalOpen(false);
      alert(mode === 'sign-in' ? '登录成功。' : '注册成功。如果 Supabase 开启了邮箱确认，请先查收邮件完成确认。');
    } catch (error) {
      console.error('云端账号操作失败:', error);
      setIsOnline(false);
      alert(mode === 'sign-in' ? '登录失败，请检查邮箱和密码。' : '注册失败，请检查邮箱、密码或 Supabase Auth 设置。');
    }
  }

  async function handleSignOut() {
    const cloud = initSupabase();
    if (!cloud) return;

    await cloud.auth.signOut();
    setCloudUser(null);
    setCloudMessage('已退出云端账号');
  }

  async function handleUploadCloudBackup() {
    const snapshot = createSnapshot(materials, categories, locations, operationLogs, projects);

    try {
      const uploaded = await uploadCloudSnapshot(snapshot, true);
      if (uploaded) alert('云端备份已上传。');
    } catch (error) {
      console.error('上传云端备份失败:', error);
      setIsOnline(false);
      setCloudMessage('云端备份上传失败，请检查 Supabase 表和权限');
      alert('上传失败。请确认 Supabase 已创建 warehouse_backups 表，并开启对应的用户权限。');
    }
  }

  async function handleRestoreCloudBackup() {
    const cloud = initSupabase();
    if (!cloud) {
      setIsCloudModalOpen(true);
      return;
    }

    const user = cloudUser ?? (await refreshCloudUser());
    if (!user) {
      openAuthModal();
      return;
    }

    if (!confirm('从云端恢复会覆盖当前本地数据，确定继续吗？')) return;

    try {
      const { data, error } = await cloud
        .from('warehouse_backups')
        .select('snapshot, updated_at')
        .eq('id', user.id)
        .single();

      if (error) throw error;

      const snapshot = parseSnapshotPayload(data?.snapshot);
      if (!snapshot) {
        alert('云端备份内容无法识别。');
        return;
      }

      await persistSnapshot(snapshot);
      setSelectedCategory('全部');
      setCloudMessage(`已从云端恢复 ${snapshot.materials.length} 条物料`);
      setIsOnline(true);
      alert(`恢复成功，共恢复 ${snapshot.materials.length} 条物料。`);
    } catch (error) {
      console.error('恢复云端备份失败:', error);
      setIsOnline(false);
      setCloudMessage('云端恢复失败，请检查 Supabase 配置和数据表');
      alert('恢复失败。请确认云端已有备份，并且 warehouse_backups 表可读取。');
    }
  }

  async function handleRestorePreviousLocalSnapshot() {
    const snapshot = readPreviousSnapshotFromLocalStorage();
    if (!snapshot || snapshot.materials.length === 0) {
      alert('没有找到可恢复的上次本机快照。请检查另一台电脑、桌面版本地备份或 Supabase 旧备份。');
      return;
    }

    if (!confirm(`找到上次本机快照，共 ${snapshot.materials.length} 条物料。确定恢复吗？`)) return;

    await persistSnapshot(snapshot);
    setSelectedCategory('全部');
    alert(`已恢复上次本机快照，共 ${snapshot.materials.length} 条物料。`);
  }

  const filteredMaterials = materials.filter((item) => {
    const matchCategory = selectedCategory === '全部' || item.category === selectedCategory;
    const matchQuickFilter =
      quickFilter === 'all' ||
      (quickFilter === 'attention' && (item.quantity === 0 || isLowStock(item))) ||
      (quickFilter === 'empty' && item.quantity === 0) ||
      (quickFilter === 'unset-location' && !item.location) ||
      (quickFilter === 'missing-image' && !item.photo_url) ||
      (quickFilter === 'missing-datasheet' && !item.datasheet_url) ||
      (quickFilter === 'missing-purchase' && !item.purchase_url);
    const query = searchQuery.trim().toLowerCase();

    const matchSearch =
      !query ||
      item.name.toLowerCase().includes(query) ||
      item.model.toLowerCase().includes(query) ||
      item.category.toLowerCase().includes(query) ||
      item.package.toLowerCase().includes(query) ||
      item.parameters.toLowerCase().includes(query) ||
      item.supplier.toLowerCase().includes(query) ||
      item.project.toLowerCase().includes(query) ||
      item.location.toLowerCase().includes(query) ||
      item.description.toLowerCase().includes(query);

    return matchCategory && matchQuickFilter && matchSearch;
  });

  const totalQuantity = materials.reduce((sum, item) => sum + item.quantity, 0);
  const outOfStockCount = materials.filter((item) => item.quantity === 0).length;
  const lowStockCount = materials.filter((item) => isLowStock(item)).length;
  const unsetLocationCount = materials.filter((item) => !item.location).length;
  const missingImageCount = materials.filter((item) => !item.photo_url).length;
  const missingDatasheetCount = materials.filter((item) => !item.datasheet_url).length;
  const missingPurchaseCount = materials.filter((item) => !item.purchase_url).length;
  const usedLocationCount = new Set(materials.map((item) => item.location).filter(Boolean)).size;
  const detailMaterial = detailMaterialId ? materials.find((item) => item.id === detailMaterialId) ?? null : null;
  const detailLogs = detailMaterial
    ? operationLogs.filter((log) => log.material_id === detailMaterial.id).slice(0, 5)
    : [];

  return (
    <div className={`app ${theme === 'dark' ? 'dark-theme' : ''}`}>
      <input
        ref={importInputRef}
        type="file"
        accept=".xls,.html,.htm,.json"
        style={{ display: 'none' }}
        onChange={(event) => void handleImportFile(event)}
      />

      <header className="header">
        <div className="header-title">
          <span className="eyebrow">Inventory Workspace</span>
          <h1>物料仓库</h1>
          <p>查找、补货、备份和维护库存，都在一个清晰的工作台里完成。</p>
        </div>
        <div className="header-actions">
          <div className="search-bar">
            <input
              type="text"
              placeholder="搜索名称、型号、分类或位置"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          <div className="sync-status">
            <span className={`sync-dot ${isOnline ? '' : 'offline'}`}></span>
            {isOnline ? '云端同步' : '本地模式'}
          </div>
          <button type="button" className="theme-toggle" onClick={toggleTheme}>
            {theme === 'dark' ? '日间' : '夜间'}
          </button>
        </div>
      </header>

      <section className="overview-grid" aria-label="库存概览">
        <div className="metric-card primary-metric">
          <span>物料条目</span>
          <strong>{materials.length}</strong>
          <small>当前筛选显示 {filteredMaterials.length} 条</small>
        </div>
        <div className="metric-card">
          <span>库存总数</span>
          <strong>{totalQuantity}</strong>
          <small>所有物料数量合计</small>
        </div>
        <div className="metric-card warning-metric">
          <span>需要关注</span>
          <strong>{lowStockCount + outOfStockCount}</strong>
          <small>{outOfStockCount} 个缺货，{lowStockCount} 个低库存</small>
        </div>
        <div className="metric-card">
          <span>已用位置</span>
          <strong>{usedLocationCount}</strong>
          <small>共维护 {locations.length} 个位置</small>
        </div>
      </section>

      <div className="backup-banner">
        <div className="backup-info">
          <strong>自动备份已开启</strong>
          <span>{backupMessage}</span>
          <span>{cloudMessage}</span>
          <span>{backupDir ? `当前目录：${backupDir}` : '当前目录：默认应用数据目录'}</span>
        </div>
        <code>{backupPath || '桌面版会自动把 Excel 和 JSON 备份写到本机。'}</code>
        <div className="backup-actions">
          <button className="secondary-inline" onClick={() => void handleChooseBackupDir()}>
            修改备份位置
          </button>
          <button className="secondary-inline" onClick={() => setIsCloudModalOpen(true)}>
            云端设置
          </button>
          {cloudUser ? (
            <button className="secondary-inline" onClick={() => void handleSignOut()}>
              退出账号
            </button>
          ) : (
            <button className="secondary-inline" onClick={openAuthModal}>
              登录云端
            </button>
          )}
          <button className="secondary-inline" onClick={() => void handleUploadCloudBackup()}>
            上传云端
          </button>
          <button className="secondary-inline" onClick={() => void handleRestoreCloudBackup()}>
            从云端恢复
          </button>
          <button className="secondary-inline" onClick={() => void handleRestorePreviousLocalSnapshot()}>
            恢复上次本机快照
          </button>
          {backupDir ? (
            <button className="secondary-inline" onClick={() => void handleResetBackupDir()}>
              恢复默认位置
            </button>
          ) : null}
        </div>
      </div>

      <div className="main-content">
        <aside className="sidebar">
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setIsCategorySectionOpen((value) => !value)}
          >
            <span>分类</span>
            <span>{isCategorySectionOpen ? '−' : '+'}</span>
          </button>
          {isCategorySectionOpen ? (
            <>
              <ul className="category-list">
                <li
                  className={selectedCategory === '全部' ? 'active' : ''}
                  onClick={() => setSelectedCategory('全部')}
                >
                  <span>全部 ({materials.length})</span>
                </li>
                <DndContext
                  sensors={sortableSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={(event) => void handleCategorySortEnd(event)}
                >
                  <SortableContext items={categories} strategy={verticalListSortingStrategy}>
                    {categories.map((category) => (
                      <SortableSidebarItem
                        key={category}
                        id={category}
                        label={`${category} (${materials.filter((item) => item.category === category).length})`}
                        isActive={selectedCategory === category}
                        deleteTitle="删除分类"
                        onClick={() => setSelectedCategory(category)}
                        onRename={() => void handleCategoryRename(category)}
                        onDelete={() => void handleCategoryDelete(category)}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
              </ul>
              <button className="add-category-btn" onClick={() => setIsCategoryModalOpen(true)}>
                + 新增分类
              </button>
            </>
          ) : null}

          <div className="sidebar-section">
            <button
              type="button"
              className="sidebar-toggle"
              onClick={() => setIsLocationSectionOpen((value) => !value)}
            >
              <span>位置</span>
              <span>{isLocationSectionOpen ? '−' : '+'}</span>
            </button>
            {isLocationSectionOpen ? (
              <>
                <ul className="category-list">
                  <DndContext
                    sensors={sortableSensors}
                    collisionDetection={closestCenter}
                    onDragEnd={(event) => void handleLocationSortEnd(event)}
                  >
                    <SortableContext items={locations} strategy={verticalListSortingStrategy}>
                      {locations.map((location) => (
                        <SortableSidebarItem
                          key={location}
                          id={location}
                          label={location}
                          deleteTitle="删除位置"
                          onRename={() => void handleLocationRename(location)}
                          onDelete={() => void handleLocationDelete(location)}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                </ul>
                <button className="add-category-btn" onClick={() => setIsLocationModalOpen(true)}>
                  + 新增位置
                </button>
              </>
            ) : null}
          </div>
        </aside>

        <main className="content">
          <div className="toolbar">
            <div>
              <strong>{selectedCategory === '全部' ? '全部物料' : selectedCategory}</strong>
              <span>共 {filteredMaterials.length} 条物料</span>
            </div>
            <div className="toolbar-actions">
              <div className="segmented-control" aria-label="切换视图">
                <button
                  type="button"
                  className={viewMode === 'card' ? 'active' : ''}
                  onClick={() => updateViewMode('card')}
                >
                  卡片
                </button>
                <button
                  type="button"
                  className={viewMode === 'table' ? 'active' : ''}
                  onClick={() => updateViewMode('table')}
                >
                  表格
                </button>
              </div>
              <button className="secondary" onClick={handleImportClick}>
                导入备份
              </button>
              <button className="secondary" onClick={handleExport}>
                导出 Excel
              </button>
              <button onClick={openAddModal}>+ 新增物料</button>
            </div>
          </div>

          <div className="quick-filters" aria-label="高级筛选">
            <button className={quickFilter === 'all' ? 'active' : ''} onClick={() => setQuickFilter('all')}>
              全部
            </button>
            <button className={quickFilter === 'attention' ? 'active' : ''} onClick={() => setQuickFilter('attention')}>
              需关注 {lowStockCount + outOfStockCount}
            </button>
            <button className={quickFilter === 'empty' ? 'active' : ''} onClick={() => setQuickFilter('empty')}>
              缺货 {outOfStockCount}
            </button>
            <button
              className={quickFilter === 'unset-location' ? 'active' : ''}
              onClick={() => setQuickFilter('unset-location')}
            >
              未设位置 {unsetLocationCount}
            </button>
            <button
              className={quickFilter === 'missing-image' ? 'active' : ''}
              onClick={() => setQuickFilter('missing-image')}
            >
              无图 {missingImageCount}
            </button>
            <button
              className={quickFilter === 'missing-datasheet' ? 'active' : ''}
              onClick={() => setQuickFilter('missing-datasheet')}
            >
              无规格书 {missingDatasheetCount}
            </button>
            <button
              className={quickFilter === 'missing-purchase' ? 'active' : ''}
              onClick={() => setQuickFilter('missing-purchase')}
            >
              无购买链接 {missingPurchaseCount}
            </button>
          </div>

          {isLoading ? (
            <div className="empty-state">加载中...</div>
          ) : filteredMaterials.length === 0 ? (
            <div className="empty-state">
              <h3>{searchQuery || selectedCategory !== '全部' ? '没有匹配的物料' : '还没有物料'}</h3>
              <p>{searchQuery || selectedCategory !== '全部' ? '试试换个关键词或切回全部分类。' : '先添加一条常用器件，之后就能快速搜索和补货。'}</p>
              <button onClick={openAddModal}>新增物料</button>
            </div>
          ) : viewMode === 'table' ? (
            <div className="material-table-wrap">
              <table className="material-table">
                <thead>
                  <tr>
                    <th>图片</th>
                    <th>名称</th>
                    <th>型号</th>
                    <th>封装</th>
                    <th>参数</th>
                    <th>分类</th>
                    <th>位置</th>
                    <th>项目</th>
                    <th>库存</th>
                    <th>预警</th>
                    <th>资料</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMaterials.map((material) => {
                    const materialIndex = materials.findIndex((item) => item.id === material.id);

                    return (
                      <tr
                        key={material.id}
                        className={material.quantity === 0 ? 'is-empty' : isLowStock(material) ? 'is-low' : ''}
                        onDoubleClick={(event) => {
                          if (isInteractiveElement(event.target)) return;
                          openEditModal(material);
                        }}
                      >
                        <td>
                          {material.photo_url ? (
                            <button
                              type="button"
                              className="image-thumb-button"
                              onClick={() => setPreviewImageUrl(material.photo_url)}
                              title="查看器件图片"
                            >
                              <img src={material.photo_url} alt={material.name} className="material-thumb small" />
                            </button>
                          ) : (
                            <span className="image-placeholder small">无</span>
                          )}
                        </td>
                        <td>
                          <strong>{material.name}</strong>
                          {material.quantity === 0 ? <span className="stock-badge danger">缺货</span> : null}
                          {isLowStock(material) ? <span className="stock-badge warning">低库存</span> : null}
                        </td>
                        <td>{material.model || '-'}</td>
                        <td>{material.package || '-'}</td>
                        <td>{material.parameters || '-'}</td>
                        <td>
                          <select
                            value={material.category}
                            onChange={(event) => void updateMaterialField(material, 'category', event.target.value)}
                          >
                            {categories.map((category) => (
                              <option key={category} value={category}>
                                {category}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            value={material.location}
                            onChange={(event) => void updateMaterialField(material, 'location', event.target.value)}
                          >
                            <option value="">未设置</option>
                            {locations.map((location) => (
                              <option key={location} value={location}>
                                {location}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>{material.project || '-'}</td>
                        <td>
                          <button className="quantity-pill" onClick={() => openStockModal(material, 'set')}>
                            {material.quantity}
                          </button>
                        </td>
                        <td>{material.low_stock_threshold}</td>
                        <td>
                          <div className="link-actions">
                            {material.purchase_url ? (
                              <button onClick={() => openExternalLink(material.purchase_url)}>购买</button>
                            ) : null}
                            {material.datasheet_url ? (
                              <button onClick={() => openExternalLink(material.datasheet_url)}>规格书</button>
                            ) : null}
                            {!material.purchase_url && !material.datasheet_url ? '-' : null}
                          </div>
                        </td>
                        <td>
                          <div className="table-actions">
                            <button onClick={() => openStockModal(material, 'in')}>入库</button>
                            <button onClick={() => openStockModal(material, 'out')}>出库</button>
                            <button
                              onClick={() => void moveMaterialByStep(material.id, 'up')}
                              disabled={materialIndex === 0}
                            >
                              上移
                            </button>
                            <button
                              onClick={() => void moveMaterialByStep(material.id, 'down')}
                              disabled={materialIndex === materials.length - 1}
                            >
                              下移
                            </button>
                            <button onClick={() => openEditModal(material)}>编辑</button>
                            <button onClick={() => void deleteMaterial(material.id)}>删除</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="material-list">
              {filteredMaterials.map((material) => {
                const materialIndex = materials.findIndex((item) => item.id === material.id);

                return (
                  <div
                    key={material.id}
                    className={`material-item ${material.quantity === 0 ? 'is-empty' : isLowStock(material) ? 'is-low' : ''}`}
                    onDoubleClick={(event) => {
                      if (isInteractiveElement(event.target)) return;
                      openEditModal(material);
                    }}
                  >
                    <div className="material-photo">
                      {material.photo_url ? (
                        <button
                          type="button"
                          className="image-thumb-button"
                          onClick={() => setPreviewImageUrl(material.photo_url)}
                          title="查看器件图片"
                        >
                          <img src={material.photo_url} alt={material.name} className="material-thumb" />
                        </button>
                      ) : (
                        <span className="image-placeholder">无图</span>
                      )}
                    </div>
                  <div className="material-info">
                    <div className="material-title-row">
                      <h4>{material.name}</h4>
                      {material.quantity === 0 ? <span className="stock-badge danger">缺货</span> : null}
                      {isLowStock(material) ? <span className="stock-badge warning">低库存</span> : null}
                    </div>
                    <div className="meta">
                      <p>型号：{material.model || '-'}</p>
                      {material.package ? <p>封装：{material.package}</p> : null}
                      {material.parameters ? <p>参数：{material.parameters}</p> : null}
                      {material.supplier ? <p>供应商：{material.supplier}</p> : null}
                      <p>预警：{material.low_stock_threshold}</p>
                      <div className="meta-controls-row">
                        <label className="meta-field">
                          <span>分类</span>
                          <select
                            value={material.category}
                            onChange={(event) =>
                              void updateMaterialField(material, 'category', event.target.value)
                            }
                          >
                            {categories.map((category) => (
                              <option key={category} value={category}>
                                {category}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="meta-field">
                          <span>位置</span>
                          <select
                            value={material.location}
                            onChange={(event) =>
                              void updateMaterialField(material, 'location', event.target.value)
                            }
                          >
                            <option value="">未设置</option>
                            {locations.map((location) => (
                              <option key={location} value={location}>
                                {location}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="meta-field meta-project">
                          <span>项目</span>
                          <select
                            value={material.project}
                            onChange={(event) =>
                              void updateMaterialField(material, 'project', event.target.value)
                            }
                          >
                            <option value="">未关联</option>
                            {projects.map((project) => (
                              <option key={project} value={project}>
                                {project}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </div>
                    {material.purchase_url || material.datasheet_url ? (
                      <div className="material-links">
                        {material.purchase_url ? (
                          <button onClick={() => openExternalLink(material.purchase_url)}>购买链接</button>
                        ) : null}
                        {material.datasheet_url ? (
                          <button onClick={() => openExternalLink(material.datasheet_url)}>规格书</button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                    <div className="material-stock">
                      <div className="stock-count">{material.quantity}</div>
                      <div className="stock-label">库存</div>
                      <div className="stock-actions">
                        <button onClick={() => void updateQuantity(material.id, -1)}>-1</button>
                        <button onClick={() => void updateQuantity(material.id, 1)}>+1</button>
                        <button onClick={() => openStockModal(material, 'set')}>盘点</button>
                      </div>
                    </div>
                    <div className="material-actions">
                      <button onClick={() => setDetailMaterialId(material.id)}>详情</button>
                      <button onClick={() => openEditModal(material)}>编辑</button>
                      <button
                        onClick={() => void moveMaterialByStep(material.id, 'up')}
                        disabled={materialIndex === 0}
                      >
                        上移
                      </button>
                      <button
                        onClick={() => void moveMaterialByStep(material.id, 'down')}
                        disabled={materialIndex === materials.length - 1}
                      >
                        下移
                      </button>
                      <button className="danger-action" onClick={() => void deleteMaterial(material.id)}>
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <section className="activity-panel">
            <div className="activity-header">
              <strong>最近操作</strong>
              <span>保留最近 {operationLogs.length} 条</span>
            </div>
            {operationLogs.length === 0 ? (
              <p className="activity-empty">还没有操作记录。</p>
            ) : (
              <ul className="activity-list">
                {operationLogs.slice(0, 8).map((log) => (
                  <li key={log.id}>
                    <span>{log.action}</span>
                    <div>
                      <strong>{log.material_name}</strong>
                      <p>{log.detail}</p>
                    </div>
                    <time>{new Date(log.created_at).toLocaleString()}</time>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>
      </div>

      {detailMaterial ? (
        <div className="modal-overlay" onClick={() => setDetailMaterialId(null)}>
          <div className="modal detail-modal" onClick={(event) => event.stopPropagation()}>
            <div className="detail-header">
              <div>
                <h2>{detailMaterial.name}</h2>
                <div className="detail-badges">
                  {detailMaterial.quantity === 0 ? <span className="stock-badge danger">缺货</span> : null}
                  {isLowStock(detailMaterial) ? <span className="stock-badge warning">低库存</span> : null}
                  <span>{detailMaterial.category}</span>
                  <span>{detailMaterial.location || '未设位置'}</span>
                  <span>{detailMaterial.project || '未关联项目'}</span>
                </div>
              </div>
              <button type="button" className="icon-close" onClick={() => setDetailMaterialId(null)}>
                ×
              </button>
            </div>

            <div className="detail-layout">
              <button
                type="button"
                className="detail-photo"
                onClick={() => detailMaterial.photo_url && setPreviewImageUrl(detailMaterial.photo_url)}
                disabled={!detailMaterial.photo_url}
              >
                {detailMaterial.photo_url ? (
                  <img src={detailMaterial.photo_url} alt={detailMaterial.name} />
                ) : (
                  <span>无图</span>
                )}
              </button>

              <div className="detail-main">
                <div className="detail-stock-panel">
                  <div>
                    <span>当前库存</span>
                    <strong>{detailMaterial.quantity}</strong>
                  </div>
                  <div className="detail-stock-actions">
                    <button onClick={() => void updateQuantity(detailMaterial.id, -1)}>-1</button>
                    <button onClick={() => void updateQuantity(detailMaterial.id, 1)}>+1</button>
                    <button onClick={() => openStockModal(detailMaterial, 'in')}>入库</button>
                    <button onClick={() => openStockModal(detailMaterial, 'out')}>出库</button>
                    <button onClick={() => openStockModal(detailMaterial, 'set')}>盘点</button>
                  </div>
                </div>

                <div className="detail-grid">
                  <div><span>型号</span><strong>{detailMaterial.model || '-'}</strong></div>
                  <div><span>封装</span><strong>{detailMaterial.package || '-'}</strong></div>
                  <div><span>参数</span><strong>{detailMaterial.parameters || '-'}</strong></div>
                  <div><span>供应商</span><strong>{detailMaterial.supplier || '-'}</strong></div>
                  <div><span>关联项目</span><strong>{detailMaterial.project || '-'}</strong></div>
                  <div><span>低库存预警</span><strong>{detailMaterial.low_stock_threshold}</strong></div>
                  <div><span>更新时间</span><strong>{new Date(detailMaterial.updated_at).toLocaleString()}</strong></div>
                </div>

                {detailMaterial.description ? (
                  <div className="detail-note">
                    <span>备注</span>
                    <p>{detailMaterial.description}</p>
                  </div>
                ) : null}

                <div className="detail-actions">
                  {detailMaterial.purchase_url ? (
                    <button onClick={() => openExternalLink(detailMaterial.purchase_url)}>购买链接</button>
                  ) : null}
                  {detailMaterial.datasheet_url ? (
                    <button onClick={() => openExternalLink(detailMaterial.datasheet_url)}>规格书</button>
                  ) : null}
                  <button
                    onClick={() => {
                      setDetailMaterialId(null);
                      openEditModal(detailMaterial);
                    }}
                  >
                    编辑物料
                  </button>
                </div>
              </div>
            </div>

            <section className="detail-log-panel">
              <strong>近期记录</strong>
              {detailLogs.length > 0 ? (
                <ul>
                  {detailLogs.map((log) => (
                    <li key={log.id}>
                      <span>{log.action}</span>
                      <p>{log.detail}</p>
                      <time>{new Date(log.created_at).toLocaleString()}</time>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>暂无该物料的操作记录。</p>
              )}
            </section>
          </div>
        </div>
      ) : null}

      {previewImageUrl ? (
        <div className="modal-overlay image-preview-overlay" onClick={() => setPreviewImageUrl('')}>
          <div className="image-preview-modal" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="icon-close" onClick={() => setPreviewImageUrl('')}>
              ×
            </button>
            <img src={previewImageUrl} alt="器件图片预览" />
          </div>
        </div>
      ) : null}

      {isModalOpen ? (
        <div className="modal-overlay">
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>{editingMaterial ? '编辑物料' : '添加物料'}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-row">
                <div className="form-group">
                  <label>名称 *</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(event) => setFormData({ ...formData, name: event.target.value })}
                    placeholder="例如：贴片电阻"
                    required
                  />
                </div>
                <div className="form-group">
                  <label>型号</label>
                  <input
                    type="text"
                    value={formData.model}
                    onChange={(event) => setFormData({ ...formData, model: event.target.value })}
                    placeholder="例如：0805 10K"
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>分类 *</label>
                  <select
                    value={formData.category}
                    onChange={(event) => setFormData({ ...formData, category: event.target.value })}
                  >
                    {categories.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>封装</label>
                  <input
                    type="text"
                    value={formData.package}
                    onChange={(event) => setFormData({ ...formData, package: event.target.value })}
                    placeholder="例如：0603 / SOT-23 / QFN32"
                  />
                </div>
                <div className="form-group">
                  <label>数量</label>
                  <input
                    type="number"
                    min="0"
                    value={formData.quantity}
                    onChange={(event) =>
                      setFormData({
                        ...formData,
                        quantity: Number.parseInt(event.target.value, 10) || 0,
                      })
                    }
                  />
                </div>
                <div className="form-group">
                  <label>低库存预警值</label>
                  <input
                    type="number"
                    min="0"
                    value={formData.low_stock_threshold}
                    onChange={(event) =>
                      setFormData({
                        ...formData,
                        low_stock_threshold: Number.parseInt(event.target.value, 10) || 0,
                      })
                    }
                  />
                </div>
              </div>

              <div className="form-group">
                <label>关键参数</label>
                <input
                  type="text"
                  value={formData.parameters}
                  onChange={(event) => setFormData({ ...formData, parameters: event.target.value })}
                  placeholder="例如：10K 1% / 3.3V LDO / I2C 温湿度"
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>供应商</label>
                  <input
                    type="text"
                    value={formData.supplier}
                    onChange={(event) => setFormData({ ...formData, supplier: event.target.value })}
                    placeholder="例如：立创商城 / DigiKey / Mouser"
                  />
                </div>
                <div className="form-group">
                  <label>购买链接</label>
                  <input
                    type="url"
                    value={formData.purchase_url}
                    onChange={(event) => setFormData({ ...formData, purchase_url: event.target.value })}
                    placeholder="https://..."
                  />
                </div>
              </div>

              <div className="form-group">
                <label>规格书链接</label>
                <input
                  type="url"
                  value={formData.datasheet_url}
                  onChange={(event) => setFormData({ ...formData, datasheet_url: event.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div className="form-group">
                <label>存放位置</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <select
                    value={formData.location}
                    onChange={(event) => setFormData({ ...formData, location: event.target.value })}
                    style={{ flex: 1 }}
                  >
                    <option value="">选择位置...</option>
                    {locations.map((location) => (
                      <option key={location} value={location}>
                        {location}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="add-btn"
                    title="新增位置"
                    onClick={() => setIsLocationModalOpen(true)}
                  >
                    +
                  </button>
                </div>
                {formData.location ? (
                  <button
                    type="button"
                    className="delete-link"
                    onClick={() => {
                      if (materials.some((item) => item.location === formData.location)) {
                        alert('该位置下还有物料，暂时不能删除。');
                        return;
                      }
                      if (!confirm(`确定删除位置“${formData.location}”吗？`)) return;
                      const nextLocations = locations.filter((item) => item !== formData.location);
                      setFormData({ ...formData, location: '' });
                      void saveLocations(nextLocations);
                    }}
                  >
                    删除这个位置
                  </button>
                ) : null}
              </div>

              <div className="form-group">
                <label>关联项目</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <select
                    value={formData.project}
                    onChange={(event) => setFormData({ ...formData, project: event.target.value })}
                    style={{ flex: 1 }}
                  >
                    <option value="">未关联项目</option>
                    {projects.map((project) => (
                      <option key={project} value={project}>
                        {project}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="add-btn"
                    title="新增项目"
                    onClick={() => setIsProjectModalOpen(true)}
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label>器件图片</label>
                <div className="image-upload-row">
                  <label className="image-upload-box">
                    {imagePreviewUrl ? (
                      <img src={imagePreviewUrl} alt="器件图片预览" />
                    ) : (
                      <span className="image-upload-empty">
                        <strong aria-hidden="true" />
                        <small>添加图片</small>
                      </span>
                    )}
                    <input type="file" accept="image/*" onChange={handleImageChange} />
                  </label>
                  <div className="image-upload-actions">
                    <strong>{imagePreviewUrl ? '器件图片已选择' : '上传一张器件照片'}</strong>
                    <span>保存后上传到云端，支持 JPG、PNG、WebP、GIF，最大 5MB。</span>
                    <label className="secondary-inline image-upload-trigger">
                      {imagePreviewUrl ? '更换图片' : '选择图片'}
                      <input type="file" accept="image/*" onChange={handleImageChange} />
                    </label>
                    {formData.photo_url ? (
                      <button type="button" className="secondary-inline" onClick={() => openExternalLink(formData.photo_url)}>
                        查看云端图片
                      </button>
                    ) : null}
                    {imagePreviewUrl ? (
                      <button
                        type="button"
                        className="secondary-inline"
                        onClick={() => {
                          setImageFile(null);
                          setImagePreviewUrl('');
                          setFormData({ ...formData, photo_url: '' });
                        }}
                      >
                        移除图片
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="form-group">
                <label>备注</label>
                <textarea
                  value={formData.description}
                  onChange={(event) => setFormData({ ...formData, description: event.target.value })}
                  placeholder="补充说明、采购信息等"
                />
              </div>

              <div className="modal-actions">
                <button type="button" className="cancel" onClick={() => setIsModalOpen(false)}>
                  取消
                </button>
                <button type="submit" className="save" disabled={isUploadingImage}>
                  {isUploadingImage ? '上传中...' : '保存'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {stockModal ? (
        <div className="modal-overlay" onClick={() => setStockModal(null)}>
          <div className="modal stock-modal" onClick={(event) => event.stopPropagation()}>
            <h2>{getStockModalTitle(stockModal.mode)}</h2>
            <form onSubmit={(event) => void handleStockSubmit(event)}>
              <div className="stock-modal-summary">
                <strong>{stockModal.material.name}</strong>
                <span>当前库存：{stockModal.material.quantity}</span>
              </div>

              <div className="form-group">
                <label>{stockModal.mode === 'set' ? '目标库存' : '数量'}</label>
                <input
                  type="number"
                  min="0"
                  value={stockModal.quantity}
                  onChange={(event) =>
                    setStockModal({
                      ...stockModal,
                      quantity: Number.parseInt(event.target.value, 10) || 0,
                    })
                  }
                  autoFocus
                />
              </div>

              <div className="modal-actions">
                <button type="button" className="cancel" onClick={() => setStockModal(null)}>
                  取消
                </button>
                <button type="submit" className="save">
                  确认
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isCloudModalOpen ? (
        <div className="modal-overlay" onClick={() => setIsCloudModalOpen(false)}>
          <div className="modal cloud-setup-modal" onClick={(event) => event.stopPropagation()}>
            <h2>云端备份设置</h2>
            <form onSubmit={(event) => void handleSaveCloudConfig(event)}>
              <div className="setup-steps">
                <section className="setup-step">
                  <span>1</span>
                  <div>
                    <strong>填写自己的 Supabase 项目</strong>
                    <p>在 Supabase Project Settings 的 API 页面复制 Project URL 和 anon public key。</p>
                    <div className="form-group">
                      <label>Supabase URL *</label>
                      <input
                        type="url"
                        value={cloudForm.url}
                        onChange={(event) => setCloudForm({ ...cloudForm, url: event.target.value })}
                        placeholder="https://xxxx.supabase.co"
                        disabled={getSupabaseConfig().isEnvConfigured}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Supabase anon key *</label>
                      <textarea
                        value={cloudForm.key}
                        onChange={(event) => setCloudForm({ ...cloudForm, key: event.target.value })}
                        placeholder="粘贴项目的 anon public key"
                        disabled={getSupabaseConfig().isEnvConfigured}
                        required
                      />
                    </div>
                  </div>
                </section>

                <section className="setup-step">
                  <span>2</span>
                  <div>
                    <strong>创建备份、图片存储和权限</strong>
                    <p>把下面 SQL 粘贴到 Supabase SQL Editor 执行。备份和图片写入都限定在登录账号名下。</p>
                    <div className="cloud-note">
                      <code>{CLOUD_SETUP_SQL}</code>
                    </div>
                    <button type="button" className="secondary-inline" onClick={() => void handleCopyCloudSql()}>
                      复制 SQL
                    </button>
                  </div>
                </section>

                <section className="setup-step">
                  <span>3</span>
                  <div>
                    <strong>检查连接</strong>
                    <p>检查项目能否访问、备份表和存储权限是否正确。</p>
                    {cloudCheckMessage ? <div className="cloud-check-result">{cloudCheckMessage}</div> : null}
                  </div>
                </section>

                <section className="setup-step">
                  <span>4</span>
                  <div>
                    <strong>登录并同步</strong>
                    <p>保存配置后，注册或登录云端账号，再上传一次当前仓库备份。</p>
                  </div>
                </section>
              </div>

              <div className="modal-actions split-actions">
                <button type="button" className="cancel danger-text" onClick={handleClearCloudConfig}>
                  清除配置
                </button>
                <div>
                  <button
                    type="button"
                    className="cancel"
                    onClick={() => void handleCheckCloudConnection()}
                    disabled={isCheckingCloud}
                  >
                    {isCheckingCloud ? '检查中...' : '检查连接'}
                  </button>
                  <button type="button" className="cancel" onClick={() => setIsCloudModalOpen(false)}>
                    取消
                  </button>
                  <button type="submit" className="save">
                    保存配置
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isAuthModalOpen ? (
        <div className="modal-overlay" onClick={() => setIsAuthModalOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>登录云端账号</h2>
            <div className="cloud-check-result">如果还没有配置云端，请先到“云端设置”填写 Supabase 并检查连接。</div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleCloudAuth('sign-in');
              }}
            >
              <div className="form-group">
                <label>邮箱 *</label>
                <input
                  type="email"
                  value={authForm.email}
                  onChange={(event) => setAuthForm({ ...authForm, email: event.target.value })}
                  placeholder="you@example.com"
                  required
                />
              </div>

              <div className="form-group">
                <label>密码 *</label>
                <input
                  type="password"
                  value={authForm.password}
                  onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })}
                  placeholder="至少 6 位"
                  required
                />
              </div>

              <div className="cloud-note">
                <strong>换电脑时怎么用</strong>
                <span>用同一个账号登录后，点击“从云端恢复”就能取回这份账号下的备份。</span>
              </div>

              <div className="modal-actions split-actions">
                <button type="button" className="cancel" onClick={() => void handleCloudAuth('sign-up')}>
                  注册账号
                </button>
                <div>
                  <button type="button" className="cancel" onClick={() => setIsAuthModalOpen(false)}>
                    取消
                  </button>
                  <button type="submit" className="save">
                    登录
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isCategoryModalOpen ? (
        <div className="modal-overlay" onClick={() => setIsCategoryModalOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>新增分类</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const value = newCategoryName.trim();
                if (!value) return;
                if (categories.includes(value)) {
                  alert('这个分类已经存在。');
                  return;
                }
                setNewCategoryName('');
                setIsCategoryModalOpen(false);
                void saveCategories([...categories, value]);
              }}
            >
              <div className="form-group">
                <label>分类名称 *</label>
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={(event) => setNewCategoryName(event.target.value)}
                  placeholder="例如：电源模块"
                  required
                />
              </div>

              <div className="modal-actions">
                <button type="button" className="cancel" onClick={() => setIsCategoryModalOpen(false)}>
                  取消
                </button>
                <button type="submit" className="save">
                  添加
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isLocationModalOpen ? (
        <div className="modal-overlay" onClick={() => setIsLocationModalOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>新增位置</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const value = newLocationName.trim();
                if (!value) return;
                if (locations.includes(value)) {
                  alert('这个位置已经存在。');
                  return;
                }
                setNewLocationName('');
                setIsLocationModalOpen(false);
                void saveLocations([...locations, value]);
              }}
            >
              <div className="form-group">
                <label>位置名称 *</label>
                <input
                  type="text"
                  value={newLocationName}
                  onChange={(event) => setNewLocationName(event.target.value)}
                  placeholder="例如：盒子 C-3"
                  required
                />
              </div>

              <div className="modal-actions">
                <button type="button" className="cancel" onClick={() => setIsLocationModalOpen(false)}>
                  取消
                </button>
                <button type="submit" className="save">
                  添加
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {isProjectModalOpen ? (
        <div className="modal-overlay" onClick={() => setIsProjectModalOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>新增项目</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const value = newProjectName.trim();
                if (!value) return;
                if (projects.includes(value)) {
                  alert('这个项目已经存在。');
                  return;
                }
                setNewProjectName('');
                setIsProjectModalOpen(false);
                setFormData({ ...formData, project: value });
                void saveProjects([...projects, value]);
              }}
            >
              <div className="form-group">
                <label>项目名称 *</label>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(event) => setNewProjectName(event.target.value)}
                  placeholder="例如：温控板 / 电源模块 / 机器人底盘"
                  required
                />
              </div>

              <div className="modal-actions">
                <button type="button" className="cancel" onClick={() => setIsProjectModalOpen(false)}>
                  取消
                </button>
                <button type="submit" className="save">
                  添加
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
