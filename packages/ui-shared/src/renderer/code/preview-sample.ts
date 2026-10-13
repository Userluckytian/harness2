// 代码预览卡的固定 TS 样例（Z10-7；refs-zcode.md:358「主体渲染一段固定 TS 预览代码」）。
//
// 用**一段固定 TS**（不随查看器当前文件变化）让用户一眼看出主题配色差异：类型注解、关键字、
// 字符串、注释、函数/接口都要覆盖到，才能展示主题的完整调色。
export const CODE_PREVIEW_SAMPLE = `// 代码主题预览
interface User {
  id: number;
  name: string;
  admin?: boolean;
}

export function greet(user: User): string {
  const role = user.admin ? '管理员' : '成员';
  return \`你好，\${user.name}（\${role}）\`;
}
`;
