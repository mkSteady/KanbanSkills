/**
 * Dashboard HTML template
 * Full-featured UI with navigation, task management, insights
 */

/**
 * Generate dashboard HTML
 * @param {object} config - Project config
 * @returns {string}
 */
export function getDashboardHtml(config) {
  const projectName = config?.name || 'Project Index';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${projectName} - Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            primary: '#3b82f6',
            success: '#10b981',
            warning: '#f59e0b',
            danger: '#ef4444',
          }
        }
      }
    }
  </script>
  <style>
    .fade-in { animation: fadeIn 0.3s ease-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
    .card-hover { transition: all 0.2s; }
    .card-hover:hover { transform: translateY(-2px); box-shadow: 0 10px 40px -10px rgba(0,0,0,0.1); }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
  <!-- Nav -->
  <nav class="bg-white border-b border-gray-200 sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex justify-between h-16">
        <div class="flex items-center gap-4">
          <span class="text-xl font-bold text-gray-900">📊 ${projectName}</span>
        </div>
        <div class="flex items-center space-x-1">
          <button onclick="navigate('overview')" class="nav-btn px-4 py-2 rounded-lg text-sm font-medium transition-colors" data-page="overview">📈 总览</button>
          <button onclick="navigate('tasks')" class="nav-btn px-4 py-2 rounded-lg text-sm font-medium transition-colors" data-page="tasks">📋 任务</button>
          <button onclick="navigate('tests')" class="nav-btn px-4 py-2 rounded-lg text-sm font-medium transition-colors" data-page="tests">🧪 测试</button>
          <button onclick="navigate('audit')" class="nav-btn px-4 py-2 rounded-lg text-sm font-medium transition-colors" data-page="audit">🔍 审计</button>
          <button onclick="navigate('deps')" class="nav-btn px-4 py-2 rounded-lg text-sm font-medium transition-colors" data-page="deps">🔗 依赖</button>
        </div>
      </div>
    </div>
  </nav>

  <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <!-- Overview -->
    <div id="page-overview" class="page fade-in">
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100 card-hover">
          <div class="text-sm font-medium text-gray-500 mb-2">测试通过率</div>
          <div id="card-tests" class="text-3xl font-bold text-success">-</div>
          <div id="card-tests-detail" class="text-sm text-gray-500 mt-1"></div>
        </div>
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100 card-hover">
          <div class="text-sm font-medium text-gray-500 mb-2">审计问题</div>
          <div id="card-audit" class="text-3xl font-bold text-warning">-</div>
          <div id="card-audit-detail" class="text-sm text-gray-500 mt-1"></div>
        </div>
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100 card-hover">
          <div class="text-sm font-medium text-gray-500 mb-2">依赖文件</div>
          <div id="card-deps" class="text-3xl font-bold text-primary">-</div>
          <div id="card-deps-detail" class="text-sm text-gray-500 mt-1"></div>
        </div>
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100 card-hover">
          <div class="text-sm font-medium text-gray-500 mb-2">运行任务</div>
          <div id="card-tasks" class="text-3xl font-bold text-gray-900">-</div>
          <div id="card-tasks-detail" class="text-sm text-gray-500 mt-1"></div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <h3 class="text-lg font-semibold text-gray-900 mb-4">📊 项目状态</h3>
          <div id="project-status" class="space-y-3">
            <div class="text-gray-400">加载中...</div>
          </div>
        </div>
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <h3 class="text-lg font-semibold text-gray-900 mb-4">⏱️ 最近活动</h3>
          <div id="recent-activity" class="space-y-3">
            <div class="text-gray-400">加载中...</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tasks -->
    <div id="page-tasks" class="page hidden fade-in">
      <div class="bg-white rounded-xl shadow-sm border border-gray-100">
        <div class="p-6 border-b border-gray-100 flex justify-between items-center">
          <h3 class="text-lg font-semibold text-gray-900">任务管理</h3>
          <div class="flex gap-2">
            <button onclick="refreshTasks()" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium">🔄 刷新</button>
            <button onclick="startTask('test-fix')" class="px-3 py-1.5 bg-primary hover:bg-blue-600 text-white rounded-lg text-sm font-medium">🚀 修复测试</button>
            <button onclick="startTask('audit-fix')" class="px-3 py-1.5 bg-warning hover:bg-yellow-600 text-white rounded-lg text-sm font-medium">🔧 修复审计</button>
          </div>
        </div>
        <div id="task-list" class="p-6">
          <div class="text-gray-400">加载中...</div>
        </div>
      </div>
    </div>

    <!-- Tests -->
    <div id="page-tests" class="page hidden fade-in">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div class="text-sm font-medium text-gray-500 mb-2">通过</div>
          <div id="tests-passed" class="text-4xl font-bold text-success">-</div>
        </div>
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div class="text-sm font-medium text-gray-500 mb-2">失败</div>
          <div id="tests-failed" class="text-4xl font-bold text-danger">-</div>
        </div>
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div class="text-sm font-medium text-gray-500 mb-2">跳过</div>
          <div id="tests-skipped" class="text-4xl font-bold text-gray-400">-</div>
        </div>
      </div>
      <div class="bg-white rounded-xl shadow-sm border border-gray-100">
        <div class="p-6 border-b border-gray-100">
          <h3 class="text-lg font-semibold text-gray-900">失败测试详情</h3>
        </div>
        <div id="test-details" class="p-6">
          <div class="text-gray-400">加载中...</div>
        </div>
      </div>
    </div>

    <!-- Audit -->
    <div id="page-audit" class="page hidden fade-in">
      <div class="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-6">
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div class="text-sm font-medium text-gray-500 mb-2">错误</div>
          <div id="audit-errors" class="text-4xl font-bold text-danger">-</div>
        </div>
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div class="text-sm font-medium text-gray-500 mb-2">警告</div>
          <div id="audit-warnings" class="text-4xl font-bold text-warning">-</div>
        </div>
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div class="text-sm font-medium text-gray-500 mb-2">提示</div>
          <div id="audit-info" class="text-4xl font-bold text-primary">-</div>
        </div>
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div class="text-sm font-medium text-gray-500 mb-2">总计</div>
          <div id="audit-total" class="text-4xl font-bold text-gray-900">-</div>
        </div>
      </div>
      <div class="bg-white rounded-xl shadow-sm border border-gray-100">
        <div class="p-6 border-b border-gray-100">
          <h3 class="text-lg font-semibold text-gray-900">问题列表</h3>
        </div>
        <div id="audit-details" class="p-6 max-h-96 overflow-y-auto">
          <div class="text-gray-400">加载中...</div>
        </div>
      </div>
    </div>

    <!-- Deps -->
    <div id="page-deps" class="page hidden fade-in">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div class="text-sm font-medium text-gray-500 mb-2">文件数</div>
          <div id="deps-files" class="text-4xl font-bold text-primary">-</div>
        </div>
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div class="text-sm font-medium text-gray-500 mb-2">依赖边</div>
          <div id="deps-edges" class="text-4xl font-bold text-gray-900">-</div>
        </div>
        <div class="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div class="text-sm font-medium text-gray-500 mb-2">循环依赖</div>
          <div id="deps-cycles" class="text-4xl font-bold text-warning">-</div>
        </div>
      </div>
      <div class="bg-white rounded-xl shadow-sm border border-gray-100">
        <div class="p-6 border-b border-gray-100">
          <h3 class="text-lg font-semibold text-gray-900">依赖分析</h3>
        </div>
        <div id="deps-details" class="p-6">
          <div class="text-gray-400">加载中...</div>
        </div>
      </div>
    </div>
  </main>

  <script>
    // Navigation
    function navigate(page) {
      document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
      document.querySelectorAll('.nav-btn').forEach(el => {
        el.classList.remove('bg-blue-100', 'text-blue-700');
        el.classList.add('text-gray-600', 'hover:bg-gray-100');
      });

      const pageEl = document.getElementById('page-' + page);
      const navBtn = document.querySelector('.nav-btn[data-page="' + page + '"]');

      if (pageEl) pageEl.classList.remove('hidden');
      if (navBtn) {
        navBtn.classList.add('bg-blue-100', 'text-blue-700');
        navBtn.classList.remove('text-gray-600', 'hover:bg-gray-100');
      }

      loadPageData(page);
    }

    async function api(path) {
      try {
        const res = await fetch('/api' + path);
        return res.json();
      } catch {
        return null;
      }
    }

    async function loadPageData(page) {
      if (page === 'overview') await loadOverview();
      if (page === 'tasks') await loadTasks();
      if (page === 'tests') await loadTests();
      if (page === 'audit') await loadAudit();
      if (page === 'deps') await loadDeps();
    }

    async function loadOverview() {
      const data = await api('/status');
      if (!data) return;

      // Test card
      if (data.test) {
        const total = data.test.passed + data.test.failed;
        const pct = total > 0 ? Math.round((data.test.passed / total) * 100) : 0;
        document.getElementById('card-tests').textContent = pct + '%';
        document.getElementById('card-tests').className = 'text-3xl font-bold ' + (data.test.failed > 0 ? 'text-danger' : 'text-success');
        document.getElementById('card-tests-detail').textContent = data.test.passed + '/' + total + ' 通过';
      }

      // Audit card
      if (data.audit) {
        document.getElementById('card-audit').textContent = data.audit.total || 0;
        document.getElementById('card-audit').className = 'text-3xl font-bold ' + (data.audit.errors > 0 ? 'text-danger' : 'text-success');
        document.getElementById('card-audit-detail').textContent = data.audit.errors + ' 错误, ' + data.audit.warnings + ' 警告';
      }

      // Deps card
      if (data.deps) {
        document.getElementById('card-deps').textContent = data.deps.totalFiles || 0;
        document.getElementById('card-deps-detail').textContent = data.deps.totalEdges + ' 边, ' + data.deps.cycleCount + ' 循环';
      }

      // Project status
      document.getElementById('project-status').innerHTML = '<div class="space-y-2">' +
        '<div class="flex justify-between p-3 bg-gray-50 rounded-lg"><span>项目</span><span class="font-medium">' + (data.project || '-') + '</span></div>' +
        '<div class="flex justify-between p-3 bg-gray-50 rounded-lg"><span>语言</span><span class="font-medium">' + (data.language || '-') + '</span></div>' +
      '</div>';
    }

    async function loadTasks() {
      document.getElementById('task-list').innerHTML = '<div class="text-gray-400">暂无运行中的任务</div>';
    }

    async function refreshTasks() { await loadTasks(); }

    async function startTask(type) {
      alert('请在终端运行: pi ' + type.replace('-', ' '));
    }

    async function loadTests() {
      const data = await api('/test-results');
      if (!data) return;

      document.getElementById('tests-passed').textContent = data.passed || 0;
      document.getElementById('tests-failed').textContent = data.failed || 0;
      document.getElementById('tests-skipped').textContent = data.skipped || 0;

      const errors = data.errors || [];
      if (errors.length === 0) {
        document.getElementById('test-details').innerHTML = '<div class="text-success">✅ 所有测试通过</div>';
      } else {
        document.getElementById('test-details').innerHTML = errors.slice(0, 20).map(e =>
          '<div class="p-3 bg-red-50 rounded-lg mb-2 border-l-4 border-red-500">' +
            '<div class="font-mono text-sm text-gray-900">' + (e.file || e.name || '-') + '</div>' +
            '<div class="text-sm text-red-600 mt-1">' + (e.message || e.error || '-') + '</div>' +
          '</div>'
        ).join('');
      }
    }

    async function loadAudit() {
      const data = await api('/audit-results');
      if (!data) return;

      const stats = data.stats || {};
      document.getElementById('audit-errors').textContent = stats.errors || 0;
      document.getElementById('audit-warnings').textContent = stats.warnings || 0;
      document.getElementById('audit-info').textContent = stats.info || 0;
      document.getElementById('audit-total').textContent = stats.total || 0;

      const issues = data.issues || [];
      if (issues.length === 0) {
        document.getElementById('audit-details').innerHTML = '<div class="text-success">✅ 无审计问题</div>';
      } else {
        const severityClass = { error: 'border-red-500 bg-red-50', warning: 'border-yellow-500 bg-yellow-50', info: 'border-blue-500 bg-blue-50' };
        document.getElementById('audit-details').innerHTML = issues.slice(0, 30).map(i =>
          '<div class="p-3 rounded-lg mb-2 border-l-4 ' + (severityClass[i.severity] || 'border-gray-500 bg-gray-50') + '">' +
            '<div class="flex justify-between"><span class="font-mono text-sm">' + i.file + ':' + i.line + '</span><span class="text-xs font-medium uppercase">' + i.severity + '</span></div>' +
            '<div class="text-sm mt-1">' + i.message + '</div>' +
          '</div>'
        ).join('');
      }
    }

    async function loadDeps() {
      const data = await api('/deps');
      if (!data || !data.stats) return;

      document.getElementById('deps-files').textContent = data.stats.totalFiles || 0;
      document.getElementById('deps-edges').textContent = data.stats.totalEdges || 0;
      document.getElementById('deps-cycles').textContent = data.stats.cycleCount || 0;

      if (data.stats.cycles && data.stats.cycles.length > 0) {
        document.getElementById('deps-details').innerHTML = '<h4 class="font-medium mb-3">循环依赖:</h4>' +
          data.stats.cycles.slice(0, 10).map(c =>
            '<div class="p-3 bg-yellow-50 rounded-lg mb-2 border-l-4 border-yellow-500">' +
              '<div class="font-mono text-sm">' + c.join(' → ') + '</div>' +
            '</div>'
          ).join('');
      } else {
        document.getElementById('deps-details').innerHTML = '<div class="text-success">✅ 无循环依赖</div>';
      }
    }

    // Init
    navigate('overview');
    setInterval(() => loadPageData('overview'), 30000);
  </script>
</body>
</html>`;
}
