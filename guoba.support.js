/**
 * 锅巴网页配置接入（guoba-plugin-next）
 *
 * 提供插件配置项，在锅巴面板里可视化修改：
 *  - pdfPassword：PDF 通用密码（userPassword）
 *  - pageSize：列表每页显示条数
 *  - imageQuality：PDF 图片压缩质量（预留）
 *
 * 说明：锅巴会读取本文件的 supportGuoba() 导出。配置读写通过
 * makeConfig 生成的 config/jmreader.yaml（字段平铺，无前缀分组）。
 */

import lodash from 'lodash'

export function supportGuoba () {
  return {
    pluginInfo: {
      name: 'jmreader',
      title: 'JMReader',
      description: 'JM 漫画搜索 / 详情 / 下载加密 PDF',
      author: 'jmreader',
      link: '',
      isV3: true,
      isV2: false,
      showInMenu: 'auto',
      icon: 'mdi:book-open-page-variant',
      iconColor: '#e63946',
    },
    configInfo: {
      schemas: [
        {
          label: '基础配置',
          component: 'SOFT_GROUP_BEGIN',
        },
        {
          field: 'pdfPassword',
          label: 'PDF 通用密码',
          helpMessage: 'PDF 加密使用双密码：通用密码（userPassword）与作品ID（ownerPassword），二选一即可打开文档。',
          bottomHelpMessage: '留空则 PDF 仅可用「作品ID」打开。修改后新生成的 PDF 生效，旧缓存不受影响。',
          component: 'Input',
          componentProps: {
            placeholder: '请输入通用密码，留空表示不设置',
          },
        },
        {
          field: 'pageSize',
          label: '每页显示条数',
          helpMessage: '搜索 / 列表结果每页显示的条数，翻页时按此粒度切分。',
          bottomHelpMessage: '范围 1 - 20，默认 10。',
          component: 'InputNumber',
          required: true,
          componentProps: {
            min: 1,
            max: 20,
            placeholder: '默认 10',
          },
        },
        {
          field: 'imageQuality',
          label: '图片压缩质量',
          helpMessage: 'PDF 内页图片的 JPEG 压缩质量（0-100）。',
          bottomHelpMessage: '数值越高越清晰、体积越大，默认 82。',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            max: 100,
            placeholder: '默认 82',
          },
        },
        {
          field: 'maxPages',
          label: 'PDF 最大页数限制',
          helpMessage: '生成 PDF 时允许的最大页数，超过则拒绝并提示改用单章下载。',
          bottomHelpMessage: '0 表示不限制。建议设一个合理值（如 100），避免整本漫画 PDF 过大、群文件上传失败。',
          component: 'InputNumber',
          componentProps: {
            min: 0,
            max: 100000,
            placeholder: '默认 0（不限制）',
          },
        },
        {
          field: 'downloadConcurrency',
          label: '下载并发数',
          helpMessage: '生成 PDF 时同时下载的图片数，越大越快，但过高可能被服务器限速或封禁。',
          bottomHelpMessage: '范围 1 - 10，默认 4。网络不稳定时建议调低。',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            max: 10,
            placeholder: '默认 4',
          },
        },
      ],
      getConfigData () {
        // 从插件配置对象读取（由 index.js 注入到全局，见下方 setConfigData 说明）
        const cfg = globalThis.__jmreaderConfig
        if (cfg) {
          return {
            pdfPassword: cfg.pdfPassword ?? '',
            pageSize: cfg.pageSize ?? 10,
            imageQuality: cfg.imageQuality ?? 82,
            maxPages: cfg.maxPages ?? 0,
            downloadConcurrency: cfg.downloadConcurrency ?? 4,
          }
        }
        return {
          pdfPassword: '',
          pageSize: 10,
          imageQuality: 82,
          maxPages: 0,
          downloadConcurrency: 4,
        }
      },
      setConfigData (data, { Result }) {
        // 通过全局钩子把锅巴写入的值回传给插件（index.js 里会读取并 configSave）
        if (typeof globalThis.__jmreaderSetConfig === 'function') {
          globalThis.__jmreaderSetConfig(data)
          return Result.ok({}, '保存成功~')
        }
        return Result.error('插件未注册配置回写钩子')
      },
    },
  }
}
