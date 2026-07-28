export interface DefaultModuleTemplateCopy {
  code: 'drink' | 'meal' | 'exercise' | 'moment';
  localTemplateId: string;
  name: string;
  description: string;
  stickerIndex: number;
}

export const DEFAULT_MODULE_TEMPLATES: DefaultModuleTemplateCopy[] = [
  {
    code: 'drink',
    localTemplateId: 'template_coffee',
    name: '饮品check！',
    description: '今天喝啥了？',
    stickerIndex: 0,
  },
  {
    code: 'meal',
    localTemplateId: 'template_meal',
    name: '美食check！',
    description: '今天吃啥了？',
    stickerIndex: 5,
  },
  {
    code: 'exercise',
    localTemplateId: 'template_exercise',
    name: '健身check！',
    description: '肌肉生长中',
    stickerIndex: 6,
  },
  {
    code: 'moment',
    localTemplateId: 'template_mood',
    name: '自律check！',
    description: '所有目标完成完成完成！',
    stickerIndex: 3,
  },
];

export function getDefaultTemplateCopy(templateId: string, index: number): DefaultModuleTemplateCopy | undefined {
  const rawCode = templateId.replace(/^(?:tpl_|template_)/, '');
  const code = rawCode === 'coffee' ? 'drink' : rawCode === 'mood' ? 'moment' : rawCode;
  return DEFAULT_MODULE_TEMPLATES.find((template) => template.code === code) ?? DEFAULT_MODULE_TEMPLATES[index];
}
