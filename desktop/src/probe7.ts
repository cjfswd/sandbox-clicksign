import { App, Text, VStack, alert } from 'perry/ui';
console.log('[t0] probe7: alert body');
setTimeout(() => {
  alert('Titulo do Alerta', 'linha um do corpo\nlinha dois do corpo');
  console.log('[alert] chamado');
}, 1500);
setTimeout(() => process.exit(0), 12000);
App({ title: 'Probe7', width: 300, height: 100, body: VStack(8, [Text('probe7')]) });
