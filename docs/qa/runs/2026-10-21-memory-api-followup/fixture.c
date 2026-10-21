#define _GNU_SOURCE
#include <sys/mman.h>
#include <sys/prctl.h>
#include <pthread.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static volatile int workers=1;
static void *idle(void *p){while(workers) usleep(10000);return 0;}
__attribute__((noinline)) static void stack(int depth){volatile char a[4096]; memset((void*)a,1,sizeof a); if(depth)stack(depth-1);else sleep(12); if(a[0]==8)puts("x");}
int main(int argc,char **argv){prctl(PR_SET_NAME,argv[1]); FILE*f=fopen(argv[2],"r+"); char cmd[40];void*m=mmap(0,32*1024*1024,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);memset(m,1,32*1024*1024);mprotect((char*)m+4096,1024*1024,PROT_NONE);munmap((char*)m+2*1024*1024,1024*1024);pthread_t threads[450];int n=0;while(fgets(cmd,sizeof cmd,f)){if(!strncmp(cmd,"grow",4))sbrk(1024*1024);if(!strncmp(cmd,"shrink",6))sbrk(-1024*1024);if(!strncmp(cmd,"stack",5))stack(100);if(!strncmp(cmd,"threads",7)){workers=1;while(n<400&&pthread_create(&threads[n],0,idle,0)==0)n++;fprintf(stderr,"threads=%d\n",n);}if(!strncmp(cmd,"reduce",6)){workers=0;while(n)pthread_join(threads[--n],0);}if(!strncmp(cmd,"map",3)){void*x=mmap(0,8*1024*1024,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);memset(x,1,8*1024*1024);}if(!strncmp(cmd,"high",4)){void*h=mmap((void*)0x20000000000000,1024*1024,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);fprintf(stderr,"high=%p\n",h);}if(!strncmp(cmd,"partial",7)){void*z=mmap(0,2200*4096,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);for(int i=0;i<2200;i+=2)mprotect((char*)z+i*4096,4096,PROT_NONE);}if(!strncmp(cmd,"exit",4))break;}return 0;}
