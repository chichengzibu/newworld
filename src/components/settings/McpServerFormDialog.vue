<template>
  <el-dialog
    :model-value="modelValue"
    :title="isEdit ? '编辑 MCP Server' : '添加 MCP Server'"
    width="600px"
    :close-on-click-modal="false"
    @update:model-value="handleDialogClose"
  >
    <el-form ref="formRef" :model="formData" :rules="formRules" label-width="120px">
      <el-form-item label="名称" prop="name">
        <el-input v-model="formData.name" placeholder="请输入名称" />
      </el-form-item>

      <el-form-item label="命令" prop="command">
        <el-input v-model="formData.command" placeholder="例如: npx -y @modelcontextprotocol/server-filesystem" />
      </el-form-item>

      <el-form-item label="参数">
        <div class="args-container">
          <div class="args-list">
            <div class="arg-row" v-for="(arg, index) in formData.args" :key="index">
              <el-input v-model="formData.args[index]" :placeholder="'参数 ' + (index + 1)" class="arg-input" />
              <el-button size="small" @click="removeArg(index)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
          </div>
          <el-button size="small" type="primary" text @click="addArg">
            <el-icon><Plus /></el-icon>
            添加参数
          </el-button>
        </div>
      </el-form-item>

      <el-form-item label="环境变量">
        <div class="env-container">
          <div class="env-list">
            <div class="env-row" v-for="(value, key) in formData.env" :key="key">
              <el-input v-model="formData.envKeys[key]" placeholder="键" class="env-key" />
              <el-input v-model="formData.env[key]" placeholder="值" class="env-value" />
              <el-button size="small" @click="removeEnv(key)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
          </div>
          <el-button size="small" type="primary" text @click="addEnv">
            <el-icon><Plus /></el-icon>
            添加环境变量
          </el-button>
        </div>
      </el-form-item>

      <el-form-item label="允许路径">
        <el-input
          v-model="allowedPathsText"
          type="textarea"
          :rows="3"
          placeholder="每行一个目录,例如:&#10;D:\MyProject&#10;留空 = 只允许访问应用自己的沙箱目录"
        />
        <div class="dir-empty">
          路径沙箱:文件类 MCP Server 只能访问这里列出的目录。未列出的目录一律拒绝 ——
          留空则只允许应用自己的沙箱目录(不包含程序的工作目录)。
        </div>
      </el-form-item>

      <el-form-item label="启用">
        <el-switch v-model="formData.enabled" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="handleDialogClose">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">
        {{ isEdit ? '保存' : '添加' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { Plus, Delete } from '@element-plus/icons-vue';

const props = defineProps<{
  modelValue: boolean;
  server?: {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabled: boolean;
    /** 路径白名单(文件类 MCP Server 只能碰这些目录) */
    allowedPaths?: string[];
  };
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'save': [data: {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    allowedPaths: string[];
    enabled: boolean;
    isEdit: boolean;
  }];
}>();

const formRef = ref<FormInstance>();
const submitting = ref(false);

const formData = reactive({
  name: '',
  command: '',
  args: [] as string[],
  env: {} as Record<string, string>,
  envKeys: {} as Record<string, string>,
  enabled: true,
});

/** 「允许路径」输入框的文本(每行一个路径) */
const allowedPathsText = ref('');

const formRules: FormRules = {
  name: [
    { required: true, message: '请输入名称', trigger: 'blur' }
  ],
  command: [
    { required: true, message: '请输入命令', trigger: 'blur' }
  ],
};

const isEdit = computed(() => !!props.server);

watch(() => props.modelValue, (visible) => {
  if (visible && props.server) {
    formData.name = props.server.name;
    formData.command = props.server.command;
    formData.args = props.server.args ? [...props.server.args] : [];
    formData.enabled = props.server.enabled;
    allowedPathsText.value = (props.server.allowedPaths ?? []).join(String.fromCharCode(10));
    
    formData.env = {};
    formData.envKeys = {};
    if (props.server.env) {
      for (const key in props.server.env) {
        formData.env[key] = props.server.env[key];
        formData.envKeys[key] = key;
      }
    }
  } else if (visible) {
    resetForm();
  }
});

function resetForm(): void {
  formData.name = '';
  formData.command = '';
  formData.args = [];
  formData.env = {};
  formData.envKeys = {};
  formData.enabled = true;
  allowedPathsText.value = '';
}

function addArg(): void {
  formData.args.push('');
}

function removeArg(index: number): void {
  formData.args.splice(index, 1);
}

function addEnv(): void {
  const key = `NEW_KEY_${Date.now()}`;
  formData.envKeys[key] = '';
  formData.env[key] = '';
}

function removeEnv(key: string): void {
  delete formData.envKeys[key];
  delete formData.env[key];
}

function handleDialogClose(): void {
  emit('update:modelValue', false);
  formRef.value?.resetFields();
}

function handleSubmit(): void {
  formRef.value?.validate(async (valid: boolean) => {
    if (!valid) return;

    submitting.value = true;
    try {
      const finalEnv: Record<string, string> = {};
      for (const tempKey in formData.envKeys) {
        const finalKey = formData.envKeys[tempKey];
        if (finalKey && finalKey.trim()) {
          finalEnv[finalKey.trim()] = formData.env[tempKey];
        }
      }

      emit('save', {
        name: formData.name,
        command: formData.command,
        args: formData.args.filter(arg => arg.trim() !== ''),
        env: finalEnv,
        allowedPaths: allowedPathsText.value
          .split(String.fromCharCode(10))
          .map(line => line.trim())
          .filter(line => line !== ''),
        enabled: formData.enabled,
        isEdit: isEdit.value,
      });
    } finally {
      submitting.value = false;
    }
  });
}
</script>

<style lang="scss" scoped>
.args-container, .env-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.args-list, .env-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.arg-row, .env-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.arg-input {
  flex: 1;
}

.env-key, .env-value {
  flex: 1;
}
</style>
