import { describe, expect, it } from 'vitest';
import { getDefaultTemplateCopy } from '../src/config/module-templates';

describe('default module template copy', () => {
  it('normalizes remote and retained local template identifiers', () => {
    expect(getDefaultTemplateCopy('tpl_drink', 0)).toMatchObject({ name: '饮品check！', description: '今天喝啥了？' });
    expect(getDefaultTemplateCopy('tpl_meal', 1)).toMatchObject({ name: '美食check！', description: '今天吃啥了？' });
    expect(getDefaultTemplateCopy('tpl_exercise', 2)).toMatchObject({ name: '健身check！', description: '肌肉生长中' });
    expect(getDefaultTemplateCopy('template_mood', 3)).toMatchObject({ name: '自律check！', description: '所有目标完成完成完成！' });
  });
});
